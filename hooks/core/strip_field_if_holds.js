'use strict';

// use opts.field and opts.fieldFilter to check if a field should be stripped
var match = require('match-object');
module.exports = function(db, item, opts, cb) {
  if (typeof item.b[opts.field] !== 'undefined') {
    if (match(opts.fieldFilter, item.b)) {
      delete item.b[opts.field];
    }
  }

  process.nextTick(function() {
    cb(null, item);
  });
};
