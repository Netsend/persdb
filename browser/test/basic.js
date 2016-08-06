'use strict';

function runTests(test, idb, PersDB, cb) {
  var dropDb = idb.dropDb;
  var recreateDb = idb.recreateDb;

  // create two conflict fixtures
  var conflict1 = {
    n: {
      h: {
        id: 'customers\x01john',
        v: 'Aaaaaaaa',
        pa: []
      },
      b: {
        email: 'john@example.com'
      }
    },
    l: null,
    c: null,
    lcas: [],
    pe: 'remote1',
    err: 'some rando'
  };
  var conflict2 = {
    n: {
      h: {
        id: 'customers\x01jane',
        v: 'Aaaaaaaa',
        pa: []
      },
      b: {
        email: 'jane@example.com'
      }
    },
    l: null,
    c: null,
    lcas: [],
    pe: 'remote2',
    err: 'unexpected local head'
  };

  // create some stores
  var opts = {
    stores: {
      customers: {},
      employees: {},
      _pdb: {},
      _conflicts: { autoIncrement: true }
    },
    data: {
      customers: {
        jane: { email: 'test@example.com' }
      },
      _conflicts: [conflict1, conflict2]
    }
  };

  var conflictStore = '_conflicts';

  var pdbOpts = {
    snapshotStore: '_pdb',
    conflictStore: conflictStore,
    startMerge: false,
    mergeTree: {
      perspectives: ['remote1', 'remote2']
    }
  };

  // ensure an empty database exists
  recreateDb('PersDB', opts, function(err, db) {
    if (err) throw err;


    test('PersDB.createNode', function(t) {
      t.plan(2);

      PersDB.createNode(db, pdbOpts, (err, pdb) => {
        t.error(err);
        t.ok(pdb);
      });
    });

    test('pdb.getConflicts', function(t) {
      // first create a pdb node to test with
      t.plan(2);

      PersDB.createNode(db, pdbOpts, (err, pdb) => {
        if (err) throw err;

        t.test('list all conflicts with the public properties', function(st) {
          var i = 0;
          pdb.getConflicts(function next(conflictKey, conflictObject, proceed) {
            i++;
            switch (i) {
            case 1:
              st.equal(conflictKey, 1);
              st.deepEqual(conflictObject, {
                store: 'customers',
                key: 'john',
                new: { email: 'john@example.com' },
                prev: null,
                conflict: [],
                remote: 'remote1',
                error: 'some rando'
              });
              break;
            case 2:
              st.equal(conflictKey, 2);
              st.deepEqual(conflictObject, {
                store: 'customers',
                key: 'jane',
                new: { email: 'jane@example.com' },
                prev: null,
                conflict: [],
                remote: 'remote2',
                error: 'unexpected local head'
              });
              break;
            default:
              throw new Error('unexpected');
            }
            proceed();
          }, function(err) {
            st.error(err);
            st.equal(i, 2);
            st.end();
          });
        });

        t.test('don\'t proceed', function(st) {
          var i = 0;
          pdb.getConflicts(function next(conflictKey, conflictObject, proceed) {
            i++;
            switch (i) {
            case 1:
              st.equal(conflictKey, 1);
              st.deepEqual(conflictObject, {
                store: 'customers',
                key: 'john',
                new: { email: 'john@example.com' },
                prev: null,
                conflict: [],
                remote: 'remote1',
                error: 'some rando'
              });
              break;
            default:
              throw new Error('unexpected');
            }
            proceed(false);
          }, function(err) {
            st.error(err);
            st.equal(i, 1);
            st.end();
          });
        });
      });
    });

    test('pdb.getConflict', function(t) {
      // first create a pdb node to test with
      t.plan(2);

      PersDB.createNode(db, pdbOpts, (err, pdb) => {
        if (err) throw err;

        t.test('get existing conflict', function(st) {
          pdb.getConflict(1, function(err, conflict, current) {
            st.error(err);
            st.deepEqual(conflict, {
              store: 'customers',
              key: 'john',
              new: { email: 'john@example.com' },
              prev: null,
              conflict: [],
              remote: 'remote1',
              error: 'some rando'
            });
            st.deepEqual(current, undefined);
            st.end();
          });
        });

        t.test('get non-existing conflict', function(st) {
          pdb.getConflict(0, function(err, conflict, current) {
            st.equal(err.message, 'conflict not found');
            st.deepEqual(conflict, undefined);
            st.deepEqual(current, undefined);
            st.end();
          });
        });
      });
    });

    // drop db
    test.onFinish(function() {
      db.close();
      dropDb('PersDB', cb);
    });
  });
}

module.exports = runTests;