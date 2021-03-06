// thunks to convert objects to iterators
if (typeof define !== 'function') { var define = require('amdefine')(module); }

define(['./stopiteration'], function(StopIteration) {

// XXX NOTE that the 'valuesOnly' parameter is not compatible with
//     mozilla's implementation.
Iterator = function(o, keysOnly, valuesOnly) {
  var it, keys, k, undef;
  if (o===undef || o===null) {
    throw TypeError(o+" has no properties");
  }
  if (typeof(o.__iterator__)==='function') {
    it = o.__iterator__();
    if (this instanceof Iterator) {
      this.next = function() { return it.next(); };
    }
  } else {
    keys = [];
    for (k in o) { keys.push(k); }
    it = Object.create(Iterator.prototype);
    k = 0;
    it.next = function() {
      var key;
      // spec says we don't need to enumerate newly-added properties, but
      // we're not allowed to return properties which have been deleted.
      for ( ; k < keys.length; k++)
        if (keys[k] in o)
          break;
      if (k < keys.length) {
        key = keys[k++];
        return keysOnly ? key : valuesOnly ? o[key] : [ key, o[key] ];
      }
      keys = o = null; // free resources
      throw StopIteration;
    };
    if (this instanceof Iterator) {
      this.next = it.next;
    }
  }
  return it;
};
Iterator.prototype = {
  next: function() { throw StopIteration; },
  __iterator__: function() { return this; }
};

if (typeof global !== "undefined") {
    global.Iterator = Iterator;
}

return Iterator;
});
