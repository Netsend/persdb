/**
 * Copyright 2016 Netsend.
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

'use strict';

var level = require('level-packager')(require('leveldown'));

function byPath(path) {
  return level(path, { keyEncoding: 'binary', valueEncoding: 'binary' });
}

function openDb(config) {
  var dbroot = config.dbroot || config.chroot || '/var/pdb';
  var data = config.name + '/data';

  // ensure leading slash in data path
  if (data[0] !== '/') {
    data = '/' + data;
  }

  // open database
  return byPath(dbroot + '/' + data);
}

openDb.byPath = byPath;

module.exports = openDb;
