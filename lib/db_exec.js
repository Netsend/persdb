/**
 * Copyright 2014, 2015, 2016 Netsend.
 *
 * This file is part of PerspectiveDB.
 *
 * PerspectiveDB is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * PerspectiveDB is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License along
 * with PerspectiveDB. If not, see <https://www.gnu.org/licenses/>.
 */

/* jshint -W116 */

'use strict';

var fs = require('fs');
var stream = require('stream');

var async = require('async');
var bson = require('bson');
var BSONStream = require('bson-stream');
var chroot = require('chroot');
var keyFilter = require('object-key-filter');
var LDJSONStream = require('ld-jsonstream');
var level = require('level-packager')(require('leveldown'));
var mkdirp = require('mkdirp');
var posix = require('posix');

var MergeTree = require('./merge_tree');
var getConnectionId = require('./get_connection_id');
var logger = require('./logger');
var noop = require('./noop');
var parsePdbConfigs = require('./parse_pdb_configs');
var remoteConnHandler = require('./remote_conn_handler');

var BSON = new bson.BSONPure.BSON();
var Transform = stream.Transform;

/**
 * Instantiates a merge tree and handles incoming and outgoing requests.
 *
 * 1. setup all import and export hooks, filters etc.
 * 2. send and receive data requests on incoming connections
 *
 * This module should not be included but forked. A message is sent when it enters
 * a certain state and to signal the parent it's ready to receive messages.
 *
 * Full FSM: init --> listen
 *
 * The first message emitted is "init" which signals that this process is ready to
 * receive configuration data, which consists of the db config, including
 * perspective configs and log configuration. File desciptors for the log should be
 * passed after sending the config.
 *
 * {
 *   log:            {Object}      // log configuration
 *   name:           {String}      // name of this database
 *   [chroot]:       {String}      // defaults to /var/pdb
 *   [hookPaths]:    {Array}       // list of paths to load hooks from
 *   [user]:         {String}      // defaults to "pdblevel"
 *   [group]:        {String}      // defaults to "pdblevel"
 *   [debug]:        {Boolean}     // defaults to false
 *   [perspectives]: {Array}       // array of other perspectives
 *   [mergeTree]:    {Object}      // any MergeTree options
 * }
 *
 * After the database is opened and hooks are loaded, this process emits a message
 * named "listen", signalling that it's ready to receive local and remote data
 * requests, a head lookup channel request, an autoMerge signal or a kill signal.
 *
 * Either a local data channel must be setup with manual merge confirmations and
 * conflict resolution, or use autoMerge to automatically write new versions. This
 * will fail if there is a merge conflict.
 *
 * Data channel and head lookup requests should be accompanied with a file
 * descriptor.
 *
 * {
 *   type: 'remoteDataChannel'
 *   perspective:       {String}      name of the perspective
 *   receiveBeforeSend: {Boolean}     whether to wait with sending of data request
 * }
 *
 * {
 *   type: 'localDataChannel'
 * }
 *
 * {
 *   type: 'headLookup'
 * }
 *
 * {
 *   type: 'kill'
 * }
 *
 * For remote data channels a data request is sent back to the client. After this a
 * data request is expected from the other side so that the real data exchange
 * (BSON) can be started.
 *
 * A data request has the following stucture:
 * {
 *   start:          {String|Boolean}  whether or not to receive data as well. Either a
 *                                     boolean or a base64 encoded version number.
 * }
 *
 * A local data channel is used to update the local tree. Only one local data
 * channel can be active. Received versions must be either new versions or
 * confirmations of merged versions. If a new version is created by a remote the
 * merge is sent back with the previous head on the connection.
 *
 * A head lookup can be done by sending an id. The last version of that id in the
 * local tree is sent back. If no id is given, the last saved version in the tree
 * is returned.
 *
 * A head lookup request has the following stucture:
 * {
 *   id:          {String}  id, optional
 *   prefixExists:{String}  prefix to search for, mutually exclusive with id,
 *                          returns first head found does not imply any specific
 *                          insertion order
 * }
 *
 * Merging remote perspectives with the local perspective can be initiated by sending
 * a local data handler or an autoMerge signal.
 *
 * {
 *   type: 'autoMerge'
 * }
 */

var log; // used after receiving the log configuration

var programName = 'dbe';

/**
 * Require all js files in the given directories.
 *
 * @param {Array} hooks  list of directories
 * @return {Object} list of hooks indexed by path
 */
function requireJsFromDirsSync(hooks) {
  if (!Array.isArray(hooks)) { throw new TypeError('hooks must be an array'); }

  var result = {};
  hooks.forEach(function(dir) {
    // ensure trailing slash
    if (dir[dir.length - 1] !== '/') {
      dir += '/';
    }

    var files = fs.readdirSync(dir);
    files.forEach(function(file) {
      // only load regular files that end with .js
      if ((file.indexOf('.js') === file.length - 3) && fs.statSync(dir + file).isFile()) {
        log.debug2('loading', dir + file);
        result[require('path').basename(file, '.js')] = require(dir + file);
      }
    });
  });

  return result;
}

// filter password out request
function debugReq(req) {
  return keyFilter(req, ['password'], true);
}

function connErrorHandler(conn, connId, err) {
  log.warning('connection error: %s %s', err, connId);
  try {
    conn.destroy();
  } catch(err) {
    log.warning('connection write or disconnect error: %s', err);
  }
}

// globals
var db;
var headLookupReceived = false;
var localDataChannelReceived = false;
var autoMergeReceived = false;
var connections = {};

/**
 * Lookup the head of a given id, the first head that matches a prefix, or the
 * head of the whole tree. Operates only on the local tree.
 */
function headLookupConnHandler(conn, mt) {
  log.debug2('head lookup channel %s %j', getConnectionId(conn), conn.address());

  var error;
  var connId = getConnectionId(conn);
  if (connections[connId]) {
    connErrorHandler(conn, connId, new Error('connection already exists'));
    return;
  }

  // expect head lookup requests
  var ls = new LDJSONStream({ maxDocLength: 512 });

  ls.on('error', function(err) {
    connErrorHandler(conn, connId, err);
  });

  connections[connId] = conn;

  conn.on('error', function(err) {
    log.err('%s: %s', connId, err);
    ls.end();
  });
  conn.on('close', function() {
    log.info('%s: close', connId);
    ls.end();
    delete connections[connId];
  });

  var ltree = mt.getLocalTree();

  conn.pipe(ls).on('readable', function() {
    var req = ls.read();
    if (req == null) { return; }
    log.debug('head lookup %j', req);

    function lookupById(id, cb) {
      var head;
      ltree.getHeads({ id: req.id, skipConflicts: true, skipDeletes: true, bson: true }, function(h, next) {
        if (head) {
          error = new Error('already found another non-conflicting and non-deleted head');
          log.err('head lookup error for %s "%s" %j %j', req.id, error, head.h, h.h);
          next(error);
          return;
        }
        head = h;
        next();
      }, function(err) {
        if (err) { cb(err); return; }

        // if head not found but in buffer then wait, otherwise cb
        if (head) {
          cb(null, head);
        } else {
          log.info('id not in tree, search buffer', id);
          if (ltree.inBufferById(id)) {
            log.info('id still in buffer to be written, wait 100ms');
            setTimeout(function() {
              lookupById(id, cb);
            }, 100);
          } else {
            log.info('id not in buffer either', id);
            cb(null, null);
          }
        }
      });
    }

    if (req.id) {
      lookupById(req.id, function(err, head) {
        if (err) { connErrorHandler(conn, connId, err); return; }

        // write the head or an empty object if not found
        if (head) {
          conn.write(head);
        } else {
          conn.write(BSON.serialize({}));
        }
      });
    } else if (req.prefixExists) {
      var head;
      ltree.getHeads({ prefix: req.prefixExists, bson: true, limit: 1 }, function(h, next) {
        head = h;
        next();
      }, function(err) {
        if (err) { connErrorHandler(conn, connId, err); return; }
        conn.write(head || BSON.serialize({}));
      });
    } else {
      ltree.lastVersion('base64', function(err, v) {
        if (err) { connErrorHandler(conn, connId, err); return; }

        if (!v) {
          // no version yet, write empty object
          conn.write(BSON.serialize({}));
        } else {
          ltree.getByVersion(v, { bson: true }, function(err, h) {
            if (err) { connErrorHandler(conn, connId, err); return; }
            if (!h) {
              error = new Error('head not found');
              log.err('head lookup error "%s"', error);
              connErrorHandler(conn, connId, error);
              return;
            }

            conn.write(h);
          });
        }
      });
    }
  });
}

/**
 * Handle incoming data for the local tree and pass back new merged versions
 * to the connection.
 *
 * Currently not possible to get older versions, only new merges from the moment
 * this handler is setup. So make sure it is setup before autoMerge is called
 * and that it is started in a synced state with the other end of the connection
 * (bootstrapped with an empty local tree).
 *
 * - setup writer to the local tree
 * - hookup merge handler to the connection (but don't start merging)
 */
function localDataConnHandler(conn, mt) {
  log.debug2('local data channel %s %j', getConnectionId(conn), conn.address());

  var connId = getConnectionId(conn);
  if (connections[connId]) {
    connErrorHandler(conn, connId, new Error('connection already exists'));
    return;
  }

  conn.on('close', function() {
    log.info('%s: close', connId);
    delete connections[connId];
  });

  connections[connId] = conn;

  // write new data to local tree
  var bs = new BSONStream();

  bs.on('error', function(err) {
    log.err('bson %s', err);
    conn.end();
  });

  // pipe data to local write stream
  conn.pipe(bs).pipe(mt.createLocalWriteStream());

  // pipe merges back
  mt.startMerge().pipe(new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform: function(obj, enc, cb) {
      cb(null, BSON.serialize(obj));
    }
  })).pipe(conn);
}

/**
 * - expect one data request
 * - send one data request
 * - maybe export data
 * - maybe import data
 */
function remoteDataConnHandler(conn, mt, pers, receiveBeforeSend) {
  log.info('client connected %s %j', getConnectionId(conn), conn.address());

  var connId = getConnectionId(conn);
  if (connections[connId]) {
    connErrorHandler(conn, connId, new Error('connection already exists'));
    return;
  }

  conn.on('error', function(err) {
    log.err('%s: %s', connId, err);
    delete connections[connId];
  });
  conn.on('close', function() {
    log.info('%s: close', connId);
    delete connections[connId];
  });

  connections[connId] = conn;

  remoteConnHandler(conn, mt, pers, receiveBeforeSend, db, function(err) {
    if (err) { connErrorHandler(conn, connId, err); return; }
  });
}

/**
 * Start listening. Expect only remoteDataChannel messages after that.
 */
function postChroot(cfg) {
  if (typeof cfg !== 'object') { throw new TypeError('cfg must be an object'); }

  // setup list of connections to initiate and create an index by perspective name
  var persCfg = parsePdbConfigs(cfg.perspectives || []);
  log.debug2('persCfg %j', debugReq(persCfg));

  // return hooksOpts with all but the pre-configured keys
  function createHooksOpts(cfg) {
    var hooksOpts = cfg.hooksOpts || {};

    Object.keys(cfg).forEach(function(key) {
      if (!~['filter', 'hooks', 'hooksOpts', 'hide'].indexOf(key)) {
        hooksOpts[key] = cfg[key];
      }
    });

    return hooksOpts;
  }

  // if hooksOpts has a hide key, push a new hook in hooks
  function ensureHideHook(hooksOpts, hooks) {
    if (hooksOpts && hooksOpts.hide) {
      // create a hook for keys to hide
      var keysToHide = hooksOpts.hide;
      hooks.push(function(db, item, opts, cb) {
        keysToHide.forEach(function(key) {
          delete item[key];
        });
        cb(null, item);
      });
    }
  }

  // load hook function in place of name
  function replaceHookNames(hooks) {
    var error;
    if (hooks && hooks.length) {
      hooks.forEach(function(hookName, i) {
        if (!cfg.loadedHooks[hookName]) {
          error = new Error('hook requested that is not loaded');
          log.err('loadHooks %s %s', error, hookName);
          throw error;
        }
        hooks[i] = cfg.loadedHooks[hookName];
      });
    }
  }

  // replace hooks and hide keys with actual hook implementations
  Object.keys(persCfg.pers).forEach(function(name) {
    var pers = persCfg.pers[name];
    if (pers.import) {
      if (pers.import.hooks) {
        replaceHookNames(pers.import.hooks);
        if (pers.import.hooksOpts) {
          ensureHideHook(pers.import.hooksOpts, pers.import.hooks);
          pers.import.hooksOpts = createHooksOpts(pers.import.hooksOpts);
        }
      }
    }
    if (pers.export) {
      if (pers.export.hooks) {
        replaceHookNames(pers.export.hooks);
        if (pers.export.hooksOpts) {
          ensureHideHook(pers.export.hooksOpts, pers.export.hooks);
          pers.export.hooksOpts = createHooksOpts(pers.export.hooksOpts);
        }
      }
    }
  });

  var mtOpts = cfg.mergeTree || {};
  mtOpts.perspectives = Object.keys(persCfg.pers);
  mtOpts.log = log;

  // set global, used in remoteDataConnHandler
  var mt = new MergeTree(db, mtOpts);

  //var cm = connManager.create({ log: log });
  var error;

  // handle incoming messages
  // determine the type of message
  function handleIncomingMsg(msg, conn) {
    log.debug2('incoming ipc message %j', msg);

    switch (msg.type) {
    case 'headLookup':
      // can only setup one head lookup channel
      if (headLookupReceived) {
        error = new Error('already registered a head lookup channel');
        log.err('%s %j', error, msg);
        connErrorHandler(conn, null, error);
        return;
      }

      headLookupReceived = true;
      headLookupConnHandler(conn, mt);
      break;
    case 'autoMerge':
      // can only start merging if currently not yet auto merging
      if (autoMergeReceived) {
        error = new Error('already auto merging');
        log.err('%s %j', error, msg);
        return;
      }

      if (localDataChannelReceived) {
        error = new Error('already received a local data channel request');
        log.err('%s %j', error, msg);
        return;
      }

      autoMergeReceived = true;

      // auto merge new non-conflicting versions
      mt.startMerge().pipe(mt.createLocalWriteStream());
      break;
    case 'localDataChannel':
      if (!conn) {
        log.err('handleIncomingMsg connection missing %j', msg);
        return;
      }

      // setup at most one local data channel
      if (localDataChannelReceived) {
        error = new Error('already received a local data channel request');
        log.err('%s %j', error, msg);
        connErrorHandler(conn, null, error);
        return;
      }

      // can only setup local data channel if currently not yet auto merging
      if (autoMergeReceived) {
        error = new Error('already auto merging');
        log.err('%s %j', error, msg);
        return;
      }

      localDataChannelReceived = true;
      localDataConnHandler(conn, mt);
      break;
    case 'remoteDataChannel':
      if (!conn) {
        log.err('handleIncomingMsg connection missing %j', msg);
        return;
      }

      // authenticated connection, incoming internal data request
      var perspective = msg.perspective;

      var pers = persCfg.pers[perspective];

      if (!pers) {
        error = new Error('unknown perspective');
        log.err('%s %j', error, msg);
        connErrorHandler(conn, perspective, error);
        return;
      }
      remoteDataConnHandler(conn, mt, pers, msg.receiveBeforeSend);
      break;
    case 'kill':
      // stop this process
      shutdown();
      break;
    default:
      error = new Error('unknown message type');
      log.err('%s %j', error, msg);
      connErrorHandler(conn, null, error);
      break;
    }
  }

  process.on('message', handleIncomingMsg);

  // handle shutdown
  var shuttingDown = false;
  function shutdown() {
    if (shuttingDown) {
      log.info('shutdown already in progress');
      return;
    }
    shuttingDown = true;
    log.info('shutting down...');

    // stop handling incoming messages
    process.removeListener('message', handleIncomingMsg);

    async.each(Object.keys(connections), function(connId, cb) {
      log.info('closing %s', connId);
      var conn = connections[connId];
      conn.once('close', cb);
      conn.end();
    }, function(err) {
      if (err) { log.err('error closing connection: %s', err); }

      mt.close(function(err) {
        if (err) { log.err('error closing mt: %s', err); }

        log.info('MergeTree closed');

        db.close(function(err) {
          if (err) { log.err('error closing db: %s', err); }
          log.notice('closed');
        });
      });
    });
  }

  // ignore kill signals
  process.once('SIGTERM', noop);
  process.once('SIGINT', noop);

  process.on('SIGUSR2', function() {
    // create object with connection stats
    var connStats = Object.keys(connections).map(function(connId) {
      var conn = connections[connId];
      var res = {};
      res[connId] = {
        read: conn.bytesRead,
        written: conn.bytesWritten
      };
      return res;
    });
    mt.stats(function(err, mtStats) {
      if (err) { log.err('SIGUSR2:\n%s', err); return; }

      log.notice('SIGUSR2:\n%j\nconnections:\n%j', mtStats, connStats);
    });
  });

  // send a "listen" signal
  process.send('listen');
}

if (typeof process.send !== 'function') {
  throw new Error('this module should be invoked via child_process.fork');
}

process.send('init');

/**
 * Expect a db config, log config and any merge tree options.
 *
 * {
 *   log:            {Object}      // log configuration
 *   name:           {String}      // name of this database
 *   [chroot]:       {String}      // defaults to /var/pdb/ + name
 *   [hookPaths]:    {Array}       // list of paths to load hooks from
 *   [user]:         {String}      // defaults to "pdblevel"
 *   [group]:        {String}      // defaults to "pdblevel"
 *   [debug]:        {Boolean}     // defaults to false
 *   [perspectives]: {Array}       // array of other perspectives
 *   [mergeTree]:    {Object}      // any MergeTree options
 * }
 */
process.once('message', function(msg) {
  if (typeof msg !== 'object') { throw new TypeError('msg must be an object'); }
  if (typeof msg.log !== 'object') { throw new TypeError('msg.log must be an object'); }
  if (!msg.name || typeof msg.name !== 'string') { throw new TypeError('msg.name must be a non-empty string'); }

  if (msg.chroot != null && typeof msg.chroot !== 'string') { throw new TypeError('msg.chroot must be a string'); }
  if (msg.hookPaths != null && !Array.isArray(msg.hookPaths)) { throw new TypeError('msg.hookPaths must be an array'); }
  if (msg.user != null && typeof msg.user !== 'string') { throw new TypeError('msg.user must be a string'); }
  if (msg.group != null && typeof msg.group !== 'string') { throw new TypeError('msg.group must be a string'); }
  if (msg.debug != null && typeof msg.debug !== 'boolean') { throw new TypeError('msg.debug must be a string'); }
  if (msg.perspectives != null && !Array.isArray(msg.perspectives)) { throw new TypeError('msg.perspectives must be an array'); }
  if (msg.mergeTree != null && typeof msg.mergeTree !== 'object') { throw new TypeError('msg.mergeTree must be an object'); }

  programName = 'dbe ' + msg.name;

  process.title = 'pdb/' + programName;

  var path = '/data';

  var user = msg.user || 'pdblevel';
  var group = msg.group || 'pdblevel';

  var dbroot = msg.chroot || ('/var/pdb/' + msg.name);

  msg.log.ident = programName;

  // open log
  logger(msg.log, function(err, l) {
    if (err) { l.err(err); throw err; }

    log = l; // use this logger in the mt's as well

    // require any hooks before chrooting
    if (msg.hookPaths) {
      try {
        msg.loadedHooks = requireJsFromDirsSync(msg.hookPaths);
      } catch(err) {
        log.err('error loading hooks: "%s" %s', msg.hookPaths, err);
        process.exit(2);
      }
    } else {
      msg.loadedHooks = {};
    }

    var uid, gid;
    try {
      uid = posix.getpwnam(user).uid;
      gid = posix.getgrnam(group).gid;
    } catch(err) {
      log.err('%s %s:%s', err, user, group);
      process.exit(3);
    }

    // chroot or exit
    function doChroot() {
      try {
        chroot(dbroot, uid, gid);
        log.debug2('changed root to %s and user:group to %s:%s', dbroot, user, group);
      } catch(err) {
        log.err('changing root or user failed: %s %s:%s "%s"', dbroot, user, group, err);
        process.exit(8);
      }
    }

    // set core limit to maximum allowed size
    posix.setrlimit('core', { soft: posix.getrlimit('core').hard });

    // open db and call postChroot or exit
    function openDbAndProceed() {
      level(path, { keyEncoding: 'binary', valueEncoding: 'binary' }, function(err, dbc) {
        if (err) {
          log.err('opening db %s', err);
          process.exit(9);
        }
        log.debug2('opened db %s', path);

        db = dbc;

        postChroot(msg);
      });
    }

    // ensure chroot exists
    mkdirp(dbroot, '755', function(err) {
      if (err) {
        log.err('cannot make chroot', err);
        process.exit(3);
      }

      // ensure database directory exists
      fs.stat(dbroot + path, function(err, stats) {
        if (err && err.code !== 'ENOENT') {
          log.err('stats on path failed %s %j', err, debugReq(msg));
          process.exit(4);
        }

        if (err && err.code === 'ENOENT') {
          fs.mkdir(dbroot + path, 0o700, function(err) {
            if (err) {
              log.err('path creation failed %s %j', err, debugReq(msg));
              process.exit(5);
            }

            fs.chown(dbroot + path, uid, gid, function(err) {
              if (err) {
                log.err('setting path ownership failed %s %j', err, debugReq(msg));
                process.exit(6);
              }

              doChroot();
              openDbAndProceed();
            });
          });
        } else {
          if (!stats.isDirectory()) {
            log.err('path exists but is not a directory %j %j', stats, debugReq(msg));
            process.exit(7);
          }
          doChroot();
          openDbAndProceed();
        }
      });
    });
  });
});
