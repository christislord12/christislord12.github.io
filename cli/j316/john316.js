// Copyright 2010 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(Module) { ..generated code.. }
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = typeof Module !== 'undefined' ? Module : {};

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)
// {{PRE_JSES}}

// Sometimes an existing Module object exists with properties
// meant to overwrite the default module functionality. Here
// we collect those properties and reapply _after_ we configure
// the current environment's defaults to avoid having to be so
// defensive during initialization.
var moduleOverrides = {};
var key;
for (key in Module) {
  if (Module.hasOwnProperty(key)) {
    moduleOverrides[key] = Module[key];
  }
}

Module['arguments'] = [];
Module['thisProgram'] = './this.program';
Module['quit'] = function(status, toThrow) {
  throw toThrow;
};
Module['preRun'] = [];
Module['postRun'] = [];

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).

var ENVIRONMENT_IS_WEB = false;
var ENVIRONMENT_IS_WORKER = false;
var ENVIRONMENT_IS_NODE = false;
var ENVIRONMENT_HAS_NODE = false;
var ENVIRONMENT_IS_SHELL = false;
ENVIRONMENT_IS_WEB = typeof window === 'object';
ENVIRONMENT_IS_WORKER = typeof importScripts === 'function';
// A web environment like Electron.js can have Node enabled, so we must
// distinguish between Node-enabled environments and Node environments per se.
// This will allow the former to do things like mount NODEFS.
// Extended check using process.versions fixes issue #8816.
// (Also makes redundant the original check that 'require' is a function.)
ENVIRONMENT_HAS_NODE = typeof process === 'object' && typeof process.versions === 'object' && typeof process.versions.node === 'string';
ENVIRONMENT_IS_NODE = ENVIRONMENT_HAS_NODE && !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_WORKER;
ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

if (Module['ENVIRONMENT']) {
  throw new Error('Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -s ENVIRONMENT=web or -s ENVIRONMENT=node)');
}


// Three configurations we can be running in:
// 1) We could be the application main() thread running in the main JS UI thread. (ENVIRONMENT_IS_WORKER == false and ENVIRONMENT_IS_PTHREAD == false)
// 2) We could be the application main() thread proxied to worker. (with Emscripten -s PROXY_TO_WORKER=1) (ENVIRONMENT_IS_WORKER == true, ENVIRONMENT_IS_PTHREAD == false)
// 3) We could be an application pthread running in a worker. (ENVIRONMENT_IS_WORKER == true and ENVIRONMENT_IS_PTHREAD == true)




// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = '';
function locateFile(path) {
  if (Module['locateFile']) {
    return Module['locateFile'](path, scriptDirectory);
  } else {
    return scriptDirectory + path;
  }
}

if (ENVIRONMENT_IS_NODE) {
  scriptDirectory = __dirname + '/';

  // Expose functionality in the same simple way that the shells work
  // Note that we pollute the global namespace here, otherwise we break in node
  var nodeFS;
  var nodePath;

  Module['read'] = function shell_read(filename, binary) {
    var ret;
    ret = tryParseAsDataURI(filename);
    if (!ret) {
      if (!nodeFS) nodeFS = require('fs');
      if (!nodePath) nodePath = require('path');
      filename = nodePath['normalize'](filename);
      ret = nodeFS['readFileSync'](filename);
    }
    return binary ? ret : ret.toString();
  };

  Module['readBinary'] = function readBinary(filename) {
    var ret = Module['read'](filename, true);
    if (!ret.buffer) {
      ret = new Uint8Array(ret);
    }
    assert(ret.buffer);
    return ret;
  };

  if (process['argv'].length > 1) {
    Module['thisProgram'] = process['argv'][1].replace(/\\/g, '/');
  }

  Module['arguments'] = process['argv'].slice(2);

  if (typeof module !== 'undefined') {
    module['exports'] = Module;
  }

  process['on']('uncaughtException', function(ex) {
    // suppress ExitStatus exceptions from showing an error
    if (!(ex instanceof ExitStatus)) {
      throw ex;
    }
  });
  // Currently node will swallow unhandled rejections, but this behavior is
  // deprecated, and in the future it will exit with error status.
  process['on']('unhandledRejection', abort);

  Module['quit'] = function(status) {
    process['exit'](status);
  };

  Module['inspect'] = function () { return '[Emscripten Module object]'; };
} else
if (ENVIRONMENT_IS_SHELL) {


  if (typeof read != 'undefined') {
    Module['read'] = function shell_read(f) {
      var data = tryParseAsDataURI(f);
      if (data) {
        return intArrayToString(data);
      }
      return read(f);
    };
  }

  Module['readBinary'] = function readBinary(f) {
    var data;
    data = tryParseAsDataURI(f);
    if (data) {
      return data;
    }
    if (typeof readbuffer === 'function') {
      return new Uint8Array(readbuffer(f));
    }
    data = read(f, 'binary');
    assert(typeof data === 'object');
    return data;
  };

  if (typeof scriptArgs != 'undefined') {
    Module['arguments'] = scriptArgs;
  } else if (typeof arguments != 'undefined') {
    Module['arguments'] = arguments;
  }

  if (typeof quit === 'function') {
    Module['quit'] = function(status) {
      quit(status);
    }
  }
} else
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  if (ENVIRONMENT_IS_WORKER) { // Check worker, not web, since window could be polyfilled
    scriptDirectory = self.location.href;
  } else if (document.currentScript) { // web
    scriptDirectory = document.currentScript.src;
  }
  // blob urls look like blob:http://site.com/etc/etc and we cannot infer anything from them.
  // otherwise, slice off the final part of the url to find the script directory.
  // if scriptDirectory does not contain a slash, lastIndexOf will return -1,
  // and scriptDirectory will correctly be replaced with an empty string.
  if (scriptDirectory.indexOf('blob:') !== 0) {
    scriptDirectory = scriptDirectory.substr(0, scriptDirectory.lastIndexOf('/')+1);
  } else {
    scriptDirectory = '';
  }


  Module['read'] = function shell_read(url) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send(null);
      return xhr.responseText;
    } catch (err) {
      var data = tryParseAsDataURI(url);
      if (data) {
        return intArrayToString(data);
      }
      throw err;
    }
  };

  if (ENVIRONMENT_IS_WORKER) {
    Module['readBinary'] = function readBinary(url) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.responseType = 'arraybuffer';
        xhr.send(null);
        return new Uint8Array(xhr.response);
      } catch (err) {
        var data = tryParseAsDataURI(url);
        if (data) {
          return data;
        }
        throw err;
      }
    };
  }

  Module['readAsync'] = function readAsync(url, onload, onerror) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function xhr_onload() {
      if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) { // file URLs can return 0
        onload(xhr.response);
        return;
      }
      var data = tryParseAsDataURI(url);
      if (data) {
        onload(data.buffer);
        return;
      }
      onerror();
    };
    xhr.onerror = onerror;
    xhr.send(null);
  };

  Module['setWindowTitle'] = function(title) { document.title = title };
} else
{
  throw new Error('environment detection error');
}

// Set up the out() and err() hooks, which are how we can print to stdout or
// stderr, respectively.
// If the user provided Module.print or printErr, use that. Otherwise,
// console.log is checked first, as 'print' on the web will open a print dialogue
// printErr is preferable to console.warn (works better in shells)
// bind(console) is necessary to fix IE/Edge closed dev tools panel behavior.
var out = Module['print'] || (typeof console !== 'undefined' ? console.log.bind(console) : (typeof print !== 'undefined' ? print : null));
var err = Module['printErr'] || (typeof printErr !== 'undefined' ? printErr : ((typeof console !== 'undefined' && console.warn.bind(console)) || out));

// Merge back in the overrides
for (key in moduleOverrides) {
  if (moduleOverrides.hasOwnProperty(key)) {
    Module[key] = moduleOverrides[key];
  }
}
// Free the object hierarchy contained in the overrides, this lets the GC
// reclaim data used e.g. in memoryInitializerRequest, which is a large typed array.
moduleOverrides = undefined;

// perform assertions in shell.js after we set up out() and err(), as otherwise if an assertion fails it cannot print the message
assert(typeof Module['memoryInitializerPrefixURL'] === 'undefined', 'Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['pthreadMainPrefixURL'] === 'undefined', 'Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['cdInitializerPrefixURL'] === 'undefined', 'Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['filePackagePrefixURL'] === 'undefined', 'Module.filePackagePrefixURL option was removed, use Module.locateFile instead');



// Copyright 2017 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

// {{PREAMBLE_ADDITIONS}}

var STACK_ALIGN = 16;

// stack management, and other functionality that is provided by the compiled code,
// should not be used before it is ready
stackSave = stackRestore = stackAlloc = function() {
  abort('cannot use the stack before compiled code is ready to run, and has provided stack access');
};

function staticAlloc(size) {
  abort('staticAlloc is no longer available at runtime; instead, perform static allocations at compile time (using makeStaticAlloc)');
}

function dynamicAlloc(size) {
  assert(DYNAMICTOP_PTR);
  var ret = HEAP32[DYNAMICTOP_PTR>>2];
  var end = (ret + size + 15) & -16;
  if (end > _emscripten_get_heap_size()) {
    abort('failure to dynamicAlloc - memory growth etc. is not supported there, call malloc/sbrk directly');
  }
  HEAP32[DYNAMICTOP_PTR>>2] = end;
  return ret;
}

function alignMemory(size, factor) {
  if (!factor) factor = STACK_ALIGN; // stack alignment (16-byte) by default
  return Math.ceil(size / factor) * factor;
}

function getNativeTypeSize(type) {
  switch (type) {
    case 'i1': case 'i8': return 1;
    case 'i16': return 2;
    case 'i32': return 4;
    case 'i64': return 8;
    case 'float': return 4;
    case 'double': return 8;
    default: {
      if (type[type.length-1] === '*') {
        return 4; // A pointer
      } else if (type[0] === 'i') {
        var bits = parseInt(type.substr(1));
        assert(bits % 8 === 0, 'getNativeTypeSize invalid bits ' + bits + ', type ' + type);
        return bits / 8;
      } else {
        return 0;
      }
    }
  }
}

function warnOnce(text) {
  if (!warnOnce.shown) warnOnce.shown = {};
  if (!warnOnce.shown[text]) {
    warnOnce.shown[text] = 1;
    err(text);
  }
}

var asm2wasmImports = { // special asm2wasm imports
    "f64-rem": function(x, y) {
        return x % y;
    },
    "debugger": function() {
        debugger;
    }
};



var jsCallStartIndex = 1;
var functionPointers = new Array(0);


// 'sig' parameter is required for the llvm backend but only when func is not
// already a WebAssembly function.
function addFunction(func, sig) {


  var base = 0;
  for (var i = base; i < base + 0; i++) {
    if (!functionPointers[i]) {
      functionPointers[i] = func;
      return jsCallStartIndex + i;
    }
  }
  throw 'Finished up all reserved function pointers. Use a higher value for RESERVED_FUNCTION_POINTERS.';

}

function removeFunction(index) {

  functionPointers[index-jsCallStartIndex] = null;
}

var funcWrappers = {};

function getFuncWrapper(func, sig) {
  if (!func) return; // on null pointer, return undefined
  assert(sig);
  if (!funcWrappers[sig]) {
    funcWrappers[sig] = {};
  }
  var sigCache = funcWrappers[sig];
  if (!sigCache[func]) {
    // optimize away arguments usage in common cases
    if (sig.length === 1) {
      sigCache[func] = function dynCall_wrapper() {
        return dynCall(sig, func);
      };
    } else if (sig.length === 2) {
      sigCache[func] = function dynCall_wrapper(arg) {
        return dynCall(sig, func, [arg]);
      };
    } else {
      // general case
      sigCache[func] = function dynCall_wrapper() {
        return dynCall(sig, func, Array.prototype.slice.call(arguments));
      };
    }
  }
  return sigCache[func];
}


function makeBigInt(low, high, unsigned) {
  return unsigned ? ((+((low>>>0)))+((+((high>>>0)))*4294967296.0)) : ((+((low>>>0)))+((+((high|0)))*4294967296.0));
}

function dynCall(sig, ptr, args) {
  if (args && args.length) {
    assert(args.length == sig.length-1);
    assert(('dynCall_' + sig) in Module, 'bad function pointer type - no table for sig \'' + sig + '\'');
    return Module['dynCall_' + sig].apply(null, [ptr].concat(args));
  } else {
    assert(sig.length == 1);
    assert(('dynCall_' + sig) in Module, 'bad function pointer type - no table for sig \'' + sig + '\'');
    return Module['dynCall_' + sig].call(null, ptr);
  }
}

var tempRet0 = 0;

var setTempRet0 = function(value) {
  tempRet0 = value;
}

var getTempRet0 = function() {
  return tempRet0;
}

function getCompilerSetting(name) {
  throw 'You must build with -s RETAIN_COMPILER_SETTINGS=1 for getCompilerSetting or emscripten_get_compiler_setting to work';
}

var Runtime = {
  // helpful errors
  getTempRet0: function() { abort('getTempRet0() is now a top-level function, after removing the Runtime object. Remove "Runtime."') },
  staticAlloc: function() { abort('staticAlloc() is now a top-level function, after removing the Runtime object. Remove "Runtime."') },
  stackAlloc: function() { abort('stackAlloc() is now a top-level function, after removing the Runtime object. Remove "Runtime."') },
};

// The address globals begin at. Very low in memory, for code size and optimization opportunities.
// Above 0 is static memory, starting with globals.
// Then the stack.
// Then 'dynamic' memory for sbrk.
var GLOBAL_BASE = 8;




// === Preamble library stuff ===

// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html





// In MINIMAL_RUNTIME, setValue() and getValue() are only available when building with safe heap enabled, for heap safety checking.
// In traditional runtime, setValue() and getValue() are always available (although their use is highly discouraged due to perf penalties)

/** @type {function(number, number, string, boolean=)} */
function setValue(ptr, value, type, noSafe) {
  type = type || 'i8';
  if (type.charAt(type.length-1) === '*') type = 'i32'; // pointers are 32-bit
    switch(type) {
      case 'i1': HEAP8[((ptr)>>0)]=value; break;
      case 'i8': HEAP8[((ptr)>>0)]=value; break;
      case 'i16': HEAP16[((ptr)>>1)]=value; break;
      case 'i32': HEAP32[((ptr)>>2)]=value; break;
      case 'i64': (tempI64 = [value>>>0,(tempDouble=value,(+(Math_abs(tempDouble))) >= 1.0 ? (tempDouble > 0.0 ? ((Math_min((+(Math_floor((tempDouble)/4294967296.0))), 4294967295.0))|0)>>>0 : (~~((+(Math_ceil((tempDouble - +(((~~(tempDouble)))>>>0))/4294967296.0)))))>>>0) : 0)],HEAP32[((ptr)>>2)]=tempI64[0],HEAP32[(((ptr)+(4))>>2)]=tempI64[1]); break;
      case 'float': HEAPF32[((ptr)>>2)]=value; break;
      case 'double': HEAPF64[((ptr)>>3)]=value; break;
      default: abort('invalid type for setValue: ' + type);
    }
}

/** @type {function(number, string, boolean=)} */
function getValue(ptr, type, noSafe) {
  type = type || 'i8';
  if (type.charAt(type.length-1) === '*') type = 'i32'; // pointers are 32-bit
    switch(type) {
      case 'i1': return HEAP8[((ptr)>>0)];
      case 'i8': return HEAP8[((ptr)>>0)];
      case 'i16': return HEAP16[((ptr)>>1)];
      case 'i32': return HEAP32[((ptr)>>2)];
      case 'i64': return HEAP32[((ptr)>>2)];
      case 'float': return HEAPF32[((ptr)>>2)];
      case 'double': return HEAPF64[((ptr)>>3)];
      default: abort('invalid type for getValue: ' + type);
    }
  return null;
}





// Wasm globals

var wasmMemory;

// Potentially used for direct table calls.
var wasmTable;


//========================================
// Runtime essentials
//========================================

// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS = 0;

/** @type {function(*, string=)} */
function assert(condition, text) {
  if (!condition) {
    abort('Assertion failed: ' + text);
  }
}

// Returns the C function with a specified identifier (for C++, you need to do manual name mangling)
function getCFunc(ident) {
  var func = Module['_' + ident]; // closure exported function
  assert(func, 'Cannot call unknown function ' + ident + ', make sure it is exported');
  return func;
}

// C calling interface.
function ccall(ident, returnType, argTypes, args, opts) {
  // For fast lookup of conversion functions
  var toC = {
    'string': function(str) {
      var ret = 0;
      if (str !== null && str !== undefined && str !== 0) { // null string
        // at most 4 bytes per UTF-8 code point, +1 for the trailing '\0'
        var len = (str.length << 2) + 1;
        ret = stackAlloc(len);
        stringToUTF8(str, ret, len);
      }
      return ret;
    },
    'array': function(arr) {
      var ret = stackAlloc(arr.length);
      writeArrayToMemory(arr, ret);
      return ret;
    }
  };

  function convertReturnValue(ret) {
    if (returnType === 'string') return UTF8ToString(ret);
    if (returnType === 'boolean') return Boolean(ret);
    return ret;
  }

  var func = getCFunc(ident);
  var cArgs = [];
  var stack = 0;
  assert(returnType !== 'array', 'Return type should not be "array".');
  if (args) {
    for (var i = 0; i < args.length; i++) {
      var converter = toC[argTypes[i]];
      if (converter) {
        if (stack === 0) stack = stackSave();
        cArgs[i] = converter(args[i]);
      } else {
        cArgs[i] = args[i];
      }
    }
  }
  var ret = func.apply(null, cArgs);
  ret = convertReturnValue(ret);
  if (stack !== 0) stackRestore(stack);
  return ret;
}

function cwrap(ident, returnType, argTypes, opts) {
  return function() {
    return ccall(ident, returnType, argTypes, arguments, opts);
  }
}

var ALLOC_NORMAL = 0; // Tries to use _malloc()
var ALLOC_STACK = 1; // Lives for the duration of the current function call
var ALLOC_DYNAMIC = 2; // Cannot be freed except through sbrk
var ALLOC_NONE = 3; // Do not allocate

// allocate(): This is for internal use. You can use it yourself as well, but the interface
//             is a little tricky (see docs right below). The reason is that it is optimized
//             for multiple syntaxes to save space in generated code. So you should
//             normally not use allocate(), and instead allocate memory using _malloc(),
//             initialize it with setValue(), and so forth.
// @slab: An array of data, or a number. If a number, then the size of the block to allocate,
//        in *bytes* (note that this is sometimes confusing: the next parameter does not
//        affect this!)
// @types: Either an array of types, one for each byte (or 0 if no type at that position),
//         or a single type which is used for the entire block. This only matters if there
//         is initial data - if @slab is a number, then this does not matter at all and is
//         ignored.
// @allocator: How to allocate memory, see ALLOC_*
/** @type {function((TypedArray|Array<number>|number), string, number, number=)} */
function allocate(slab, types, allocator, ptr) {
  var zeroinit, size;
  if (typeof slab === 'number') {
    zeroinit = true;
    size = slab;
  } else {
    zeroinit = false;
    size = slab.length;
  }

  var singleType = typeof types === 'string' ? types : null;

  var ret;
  if (allocator == ALLOC_NONE) {
    ret = ptr;
  } else {
    ret = [_malloc,
    stackAlloc,
    dynamicAlloc][allocator](Math.max(size, singleType ? 1 : types.length));
  }

  if (zeroinit) {
    var stop;
    ptr = ret;
    assert((ret & 3) == 0);
    stop = ret + (size & ~3);
    for (; ptr < stop; ptr += 4) {
      HEAP32[((ptr)>>2)]=0;
    }
    stop = ret + size;
    while (ptr < stop) {
      HEAP8[((ptr++)>>0)]=0;
    }
    return ret;
  }

  if (singleType === 'i8') {
    if (slab.subarray || slab.slice) {
      HEAPU8.set(/** @type {!Uint8Array} */ (slab), ret);
    } else {
      HEAPU8.set(new Uint8Array(slab), ret);
    }
    return ret;
  }

  var i = 0, type, typeSize, previousType;
  while (i < size) {
    var curr = slab[i];

    type = singleType || types[i];
    if (type === 0) {
      i++;
      continue;
    }
    assert(type, 'Must know what type to store in allocate!');

    if (type == 'i64') type = 'i32'; // special case: we have one i32 here, and one i32 later

    setValue(ret+i, curr, type);

    // no need to look up size unless type changes, so cache it
    if (previousType !== type) {
      typeSize = getNativeTypeSize(type);
      previousType = type;
    }
    i += typeSize;
  }

  return ret;
}

// Allocate memory during any stage of startup - static memory early on, dynamic memory later, malloc when ready
function getMemory(size) {
  if (!runtimeInitialized) return dynamicAlloc(size);
  return _malloc(size);
}




/** @type {function(number, number=)} */
function Pointer_stringify(ptr, length) {
  abort("this function has been removed - you should use UTF8ToString(ptr, maxBytesToRead) instead!");
}

// Given a pointer 'ptr' to a null-terminated ASCII-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.

function AsciiToString(ptr) {
  var str = '';
  while (1) {
    var ch = HEAPU8[((ptr++)>>0)];
    if (!ch) return str;
    str += String.fromCharCode(ch);
  }
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in ASCII form. The copy will require at most str.length+1 bytes of space in the HEAP.

function stringToAscii(str, outPtr) {
  return writeAsciiToMemory(str, outPtr, false);
}


// Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the given array that contains uint8 values, returns
// a copy of that string as a Javascript String object.

var UTF8Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf8') : undefined;

/**
 * @param {number} idx
 * @param {number=} maxBytesToRead
 * @return {string}
 */
function UTF8ArrayToString(u8Array, idx, maxBytesToRead) {
  var endIdx = idx + maxBytesToRead;
  var endPtr = idx;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on null terminator by itself.
  // Also, use the length info to avoid running tiny strings through TextDecoder, since .subarray() allocates garbage.
  // (As a tiny code save trick, compare endPtr against endIdx using a negation, so that undefined means Infinity)
  while (u8Array[endPtr] && !(endPtr >= endIdx)) ++endPtr;

  if (endPtr - idx > 16 && u8Array.subarray && UTF8Decoder) {
    return UTF8Decoder.decode(u8Array.subarray(idx, endPtr));
  } else {
    var str = '';
    // If building with TextDecoder, we have already computed the string length above, so test loop end condition against that
    while (idx < endPtr) {
      // For UTF8 byte structure, see:
      // http://en.wikipedia.org/wiki/UTF-8#Description
      // https://www.ietf.org/rfc/rfc2279.txt
      // https://tools.ietf.org/html/rfc3629
      var u0 = u8Array[idx++];
      if (!(u0 & 0x80)) { str += String.fromCharCode(u0); continue; }
      var u1 = u8Array[idx++] & 63;
      if ((u0 & 0xE0) == 0xC0) { str += String.fromCharCode(((u0 & 31) << 6) | u1); continue; }
      var u2 = u8Array[idx++] & 63;
      if ((u0 & 0xF0) == 0xE0) {
        u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
      } else {
        if ((u0 & 0xF8) != 0xF0) warnOnce('Invalid UTF-8 leading byte 0x' + u0.toString(16) + ' encountered when deserializing a UTF-8 string on the asm.js/wasm heap to a JS string!');
        u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (u8Array[idx++] & 63);
      }

      if (u0 < 0x10000) {
        str += String.fromCharCode(u0);
      } else {
        var ch = u0 - 0x10000;
        str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
      }
    }
  }
  return str;
}

// Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the emscripten HEAP, returns a
// copy of that string as a Javascript String object.
// maxBytesToRead: an optional length that specifies the maximum number of bytes to read. You can omit
//                 this parameter to scan the string until the first \0 byte. If maxBytesToRead is
//                 passed, and the string at [ptr, ptr+maxBytesToReadr[ contains a null byte in the
//                 middle, then the string will cut short at that byte index (i.e. maxBytesToRead will
//                 not produce a string of exact length [ptr, ptr+maxBytesToRead[)
//                 N.B. mixing frequent uses of UTF8ToString() with and without maxBytesToRead may
//                 throw JS JIT optimizations off, so it is worth to consider consistently using one
//                 style or the other.
/**
 * @param {number} ptr
 * @param {number=} maxBytesToRead
 * @return {string}
 */
function UTF8ToString(ptr, maxBytesToRead) {
  return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : '';
}

// Copies the given Javascript String object 'str' to the given byte array at address 'outIdx',
// encoded in UTF8 form and null-terminated. The copy will require at most str.length*4+1 bytes of space in the HEAP.
// Use the function lengthBytesUTF8 to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   outU8Array: the array to copy to. Each index in this array is assumed to be one 8-byte element.
//   outIdx: The starting offset in the array to begin the copying.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array.
//                    This count should include the null terminator,
//                    i.e. if maxBytesToWrite=1, only the null terminator will be written and nothing else.
//                    maxBytesToWrite=0 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF8Array(str, outU8Array, outIdx, maxBytesToWrite) {
  if (!(maxBytesToWrite > 0)) // Parameter maxBytesToWrite is not optional. Negative values, 0, null, undefined and false each don't write out any bytes.
    return 0;

  var startIdx = outIdx;
  var endIdx = outIdx + maxBytesToWrite - 1; // -1 for string null terminator.
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! So decode UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description and https://www.ietf.org/rfc/rfc2279.txt and https://tools.ietf.org/html/rfc3629
    var u = str.charCodeAt(i); // possibly a lead surrogate
    if (u >= 0xD800 && u <= 0xDFFF) {
      var u1 = str.charCodeAt(++i);
      u = 0x10000 + ((u & 0x3FF) << 10) | (u1 & 0x3FF);
    }
    if (u <= 0x7F) {
      if (outIdx >= endIdx) break;
      outU8Array[outIdx++] = u;
    } else if (u <= 0x7FF) {
      if (outIdx + 1 >= endIdx) break;
      outU8Array[outIdx++] = 0xC0 | (u >> 6);
      outU8Array[outIdx++] = 0x80 | (u & 63);
    } else if (u <= 0xFFFF) {
      if (outIdx + 2 >= endIdx) break;
      outU8Array[outIdx++] = 0xE0 | (u >> 12);
      outU8Array[outIdx++] = 0x80 | ((u >> 6) & 63);
      outU8Array[outIdx++] = 0x80 | (u & 63);
    } else {
      if (outIdx + 3 >= endIdx) break;
      if (u >= 0x200000) warnOnce('Invalid Unicode code point 0x' + u.toString(16) + ' encountered when serializing a JS string to an UTF-8 string on the asm.js/wasm heap! (Valid unicode code points should be in range 0-0x1FFFFF).');
      outU8Array[outIdx++] = 0xF0 | (u >> 18);
      outU8Array[outIdx++] = 0x80 | ((u >> 12) & 63);
      outU8Array[outIdx++] = 0x80 | ((u >> 6) & 63);
      outU8Array[outIdx++] = 0x80 | (u & 63);
    }
  }
  // Null-terminate the pointer to the buffer.
  outU8Array[outIdx] = 0;
  return outIdx - startIdx;
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF8 form. The copy will require at most str.length*4+1 bytes of space in the HEAP.
// Use the function lengthBytesUTF8 to compute the exact number of bytes (excluding null terminator) that this function will write.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF8(str, outPtr, maxBytesToWrite) {
  assert(typeof maxBytesToWrite == 'number', 'stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!');
  return stringToUTF8Array(str, HEAPU8,outPtr, maxBytesToWrite);
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF8 byte array, EXCLUDING the null terminator byte.
function lengthBytesUTF8(str) {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! So decode UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var u = str.charCodeAt(i); // possibly a lead surrogate
    if (u >= 0xD800 && u <= 0xDFFF) u = 0x10000 + ((u & 0x3FF) << 10) | (str.charCodeAt(++i) & 0x3FF);
    if (u <= 0x7F) ++len;
    else if (u <= 0x7FF) len += 2;
    else if (u <= 0xFFFF) len += 3;
    else len += 4;
  }
  return len;
}


// Given a pointer 'ptr' to a null-terminated UTF16LE-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.

var UTF16Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-16le') : undefined;
function UTF16ToString(ptr) {
  assert(ptr % 2 == 0, 'Pointer passed to UTF16ToString must be aligned to two bytes!');
  var endPtr = ptr;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on null terminator by itself.
  // Also, use the length info to avoid running tiny strings through TextDecoder, since .subarray() allocates garbage.
  var idx = endPtr >> 1;
  while (HEAP16[idx]) ++idx;
  endPtr = idx << 1;

  if (endPtr - ptr > 32 && UTF16Decoder) {
    return UTF16Decoder.decode(HEAPU8.subarray(ptr, endPtr));
  } else {
    var i = 0;

    var str = '';
    while (1) {
      var codeUnit = HEAP16[(((ptr)+(i*2))>>1)];
      if (codeUnit == 0) return str;
      ++i;
      // fromCharCode constructs a character from a UTF-16 code unit, so we can pass the UTF16 string right through.
      str += String.fromCharCode(codeUnit);
    }
  }
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF16 form. The copy will require at most str.length*4+2 bytes of space in the HEAP.
// Use the function lengthBytesUTF16() to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   outPtr: Byte address in Emscripten HEAP where to write the string to.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array. This count should include the null
//                    terminator, i.e. if maxBytesToWrite=2, only the null terminator will be written and nothing else.
//                    maxBytesToWrite<2 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF16(str, outPtr, maxBytesToWrite) {
  assert(outPtr % 2 == 0, 'Pointer passed to stringToUTF16 must be aligned to two bytes!');
  assert(typeof maxBytesToWrite == 'number', 'stringToUTF16(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!');
  // Backwards compatibility: if max bytes is not specified, assume unsafe unbounded write is allowed.
  if (maxBytesToWrite === undefined) {
    maxBytesToWrite = 0x7FFFFFFF;
  }
  if (maxBytesToWrite < 2) return 0;
  maxBytesToWrite -= 2; // Null terminator.
  var startPtr = outPtr;
  var numCharsToWrite = (maxBytesToWrite < str.length*2) ? (maxBytesToWrite / 2) : str.length;
  for (var i = 0; i < numCharsToWrite; ++i) {
    // charCodeAt returns a UTF-16 encoded code unit, so it can be directly written to the HEAP.
    var codeUnit = str.charCodeAt(i); // possibly a lead surrogate
    HEAP16[((outPtr)>>1)]=codeUnit;
    outPtr += 2;
  }
  // Null-terminate the pointer to the HEAP.
  HEAP16[((outPtr)>>1)]=0;
  return outPtr - startPtr;
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF16 byte array, EXCLUDING the null terminator byte.

function lengthBytesUTF16(str) {
  return str.length*2;
}

function UTF32ToString(ptr) {
  assert(ptr % 4 == 0, 'Pointer passed to UTF32ToString must be aligned to four bytes!');
  var i = 0;

  var str = '';
  while (1) {
    var utf32 = HEAP32[(((ptr)+(i*4))>>2)];
    if (utf32 == 0)
      return str;
    ++i;
    // Gotcha: fromCharCode constructs a character from a UTF-16 encoded code (pair), not from a Unicode code point! So encode the code point to UTF-16 for constructing.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    if (utf32 >= 0x10000) {
      var ch = utf32 - 0x10000;
      str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
    } else {
      str += String.fromCharCode(utf32);
    }
  }
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF32 form. The copy will require at most str.length*4+4 bytes of space in the HEAP.
// Use the function lengthBytesUTF32() to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   outPtr: Byte address in Emscripten HEAP where to write the string to.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array. This count should include the null
//                    terminator, i.e. if maxBytesToWrite=4, only the null terminator will be written and nothing else.
//                    maxBytesToWrite<4 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF32(str, outPtr, maxBytesToWrite) {
  assert(outPtr % 4 == 0, 'Pointer passed to stringToUTF32 must be aligned to four bytes!');
  assert(typeof maxBytesToWrite == 'number', 'stringToUTF32(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!');
  // Backwards compatibility: if max bytes is not specified, assume unsafe unbounded write is allowed.
  if (maxBytesToWrite === undefined) {
    maxBytesToWrite = 0x7FFFFFFF;
  }
  if (maxBytesToWrite < 4) return 0;
  var startPtr = outPtr;
  var endPtr = startPtr + maxBytesToWrite - 4;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! We must decode the string to UTF-32 to the heap.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var codeUnit = str.charCodeAt(i); // possibly a lead surrogate
    if (codeUnit >= 0xD800 && codeUnit <= 0xDFFF) {
      var trailSurrogate = str.charCodeAt(++i);
      codeUnit = 0x10000 + ((codeUnit & 0x3FF) << 10) | (trailSurrogate & 0x3FF);
    }
    HEAP32[((outPtr)>>2)]=codeUnit;
    outPtr += 4;
    if (outPtr + 4 > endPtr) break;
  }
  // Null-terminate the pointer to the HEAP.
  HEAP32[((outPtr)>>2)]=0;
  return outPtr - startPtr;
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF16 byte array, EXCLUDING the null terminator byte.

function lengthBytesUTF32(str) {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! We must decode the string to UTF-32 to the heap.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var codeUnit = str.charCodeAt(i);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDFFF) ++i; // possibly a lead surrogate, so skip over the tail surrogate.
    len += 4;
  }

  return len;
}

// Allocate heap space for a JS string, and write it there.
// It is the responsibility of the caller to free() that memory.
function allocateUTF8(str) {
  var size = lengthBytesUTF8(str) + 1;
  var ret = _malloc(size);
  if (ret) stringToUTF8Array(str, HEAP8, ret, size);
  return ret;
}

// Allocate stack space for a JS string, and write it there.
function allocateUTF8OnStack(str) {
  var size = lengthBytesUTF8(str) + 1;
  var ret = stackAlloc(size);
  stringToUTF8Array(str, HEAP8, ret, size);
  return ret;
}

// Deprecated: This function should not be called because it is unsafe and does not provide
// a maximum length limit of how many bytes it is allowed to write. Prefer calling the
// function stringToUTF8Array() instead, which takes in a maximum length that can be used
// to be secure from out of bounds writes.
/** @deprecated */
function writeStringToMemory(string, buffer, dontAddNull) {
  warnOnce('writeStringToMemory is deprecated and should not be called! Use stringToUTF8() instead!');

  var /** @type {number} */ lastChar, /** @type {number} */ end;
  if (dontAddNull) {
    // stringToUTF8Array always appends null. If we don't want to do that, remember the
    // character that existed at the location where the null will be placed, and restore
    // that after the write (below).
    end = buffer + lengthBytesUTF8(string);
    lastChar = HEAP8[end];
  }
  stringToUTF8(string, buffer, Infinity);
  if (dontAddNull) HEAP8[end] = lastChar; // Restore the value under the null character.
}

function writeArrayToMemory(array, buffer) {
  assert(array.length >= 0, 'writeArrayToMemory array must have a length (should be an array or typed array)')
  HEAP8.set(array, buffer);
}

function writeAsciiToMemory(str, buffer, dontAddNull) {
  for (var i = 0; i < str.length; ++i) {
    assert(str.charCodeAt(i) === str.charCodeAt(i)&0xff);
    HEAP8[((buffer++)>>0)]=str.charCodeAt(i);
  }
  // Null-terminate the pointer to the HEAP.
  if (!dontAddNull) HEAP8[((buffer)>>0)]=0;
}





function demangle(func) {
  return func;
}

function demangleAll(text) {
  var regex =
    /__Z[\w\d_]+/g;
  return text.replace(regex,
    function(x) {
      var y = demangle(x);
      return x === y ? x : (y + ' [' + x + ']');
    });
}

function jsStackTrace() {
  var err = new Error();
  if (!err.stack) {
    // IE10+ special cases: It does have callstack info, but it is only populated if an Error object is thrown,
    // so try that as a special-case.
    try {
      throw new Error(0);
    } catch(e) {
      err = e;
    }
    if (!err.stack) {
      return '(no stack trace available)';
    }
  }
  return err.stack.toString();
}

function stackTrace() {
  var js = jsStackTrace();
  if (Module['extraStackTrace']) js += '\n' + Module['extraStackTrace']();
  return demangleAll(js);
}



// Memory management

var PAGE_SIZE = 16384;
var WASM_PAGE_SIZE = 65536;
var ASMJS_PAGE_SIZE = 16777216;

function alignUp(x, multiple) {
  if (x % multiple > 0) {
    x += multiple - (x % multiple);
  }
  return x;
}

var HEAP,
/** @type {ArrayBuffer} */
  buffer,
/** @type {Int8Array} */
  HEAP8,
/** @type {Uint8Array} */
  HEAPU8,
/** @type {Int16Array} */
  HEAP16,
/** @type {Uint16Array} */
  HEAPU16,
/** @type {Int32Array} */
  HEAP32,
/** @type {Uint32Array} */
  HEAPU32,
/** @type {Float32Array} */
  HEAPF32,
/** @type {Float64Array} */
  HEAPF64;

function updateGlobalBufferViews() {
  Module['HEAP8'] = HEAP8 = new Int8Array(buffer);
  Module['HEAP16'] = HEAP16 = new Int16Array(buffer);
  Module['HEAP32'] = HEAP32 = new Int32Array(buffer);
  Module['HEAPU8'] = HEAPU8 = new Uint8Array(buffer);
  Module['HEAPU16'] = HEAPU16 = new Uint16Array(buffer);
  Module['HEAPU32'] = HEAPU32 = new Uint32Array(buffer);
  Module['HEAPF32'] = HEAPF32 = new Float32Array(buffer);
  Module['HEAPF64'] = HEAPF64 = new Float64Array(buffer);
}


var STATIC_BASE = 8,
    STACK_BASE = 2944,
    STACKTOP = STACK_BASE,
    STACK_MAX = 5245824,
    DYNAMIC_BASE = 5245824,
    DYNAMICTOP_PTR = 2912;

assert(STACK_BASE % 16 === 0, 'stack must start aligned');
assert(DYNAMIC_BASE % 16 === 0, 'heap must start aligned');



var TOTAL_STACK = 5242880;
if (Module['TOTAL_STACK']) assert(TOTAL_STACK === Module['TOTAL_STACK'], 'the stack size can no longer be determined at runtime')

var INITIAL_TOTAL_MEMORY = Module['TOTAL_MEMORY'] || 16777216;
if (INITIAL_TOTAL_MEMORY < TOTAL_STACK) err('TOTAL_MEMORY should be larger than TOTAL_STACK, was ' + INITIAL_TOTAL_MEMORY + '! (TOTAL_STACK=' + TOTAL_STACK + ')');

// Initialize the runtime's memory
// check for full engine support (use string 'subarray' to avoid closure compiler confusion)
assert(typeof Int32Array !== 'undefined' && typeof Float64Array !== 'undefined' && Int32Array.prototype.subarray !== undefined && Int32Array.prototype.set !== undefined,
       'JS engine does not provide full typed array support');







  if (Module['buffer']) {
    buffer = Module['buffer'];
  }
  else {
    buffer = new ArrayBuffer(INITIAL_TOTAL_MEMORY);
  }


// If the user provides an incorrect length, just use that length instead rather than providing the user to
// specifically provide the memory length with Module['TOTAL_MEMORY'].
INITIAL_TOTAL_MEMORY = buffer.byteLength;
updateGlobalBufferViews();

HEAP32[DYNAMICTOP_PTR>>2] = DYNAMIC_BASE;


// Initializes the stack cookie. Called at the startup of main and at the startup of each thread in pthreads mode.
function writeStackCookie() {
  assert((STACK_MAX & 3) == 0);
  HEAPU32[(STACK_MAX >> 2)-1] = 0x02135467;
  HEAPU32[(STACK_MAX >> 2)-2] = 0x89BACDFE;
}

function checkStackCookie() {
  var cookie1 = HEAPU32[(STACK_MAX >> 2)-1];
  var cookie2 = HEAPU32[(STACK_MAX >> 2)-2];
  if (cookie1 != 0x02135467 || cookie2 != 0x89BACDFE) {
    abort('Stack overflow! Stack cookie has been overwritten, expected hex dwords 0x89BACDFE and 0x02135467, but received 0x' + cookie2.toString(16) + ' ' + cookie1.toString(16));
  }
  // Also test the global address 0 for integrity.
  // We don't do this with ASan because ASan does its own checks for this.
  if (HEAP32[0] !== 0x63736d65 /* 'emsc' */) abort('Runtime error: The application has corrupted its heap memory area (address zero)!');
}

function abortStackOverflow(allocSize) {
  abort('Stack overflow! Attempted to allocate ' + allocSize + ' bytes on the stack, but stack has only ' + (STACK_MAX - stackSave() + allocSize) + ' bytes available!');
}


  HEAP32[0] = 0x63736d65; /* 'emsc' */



// Endianness check (note: assumes compiler arch was little-endian)
HEAP16[1] = 0x6373;
if (HEAPU8[2] !== 0x73 || HEAPU8[3] !== 0x63) throw 'Runtime error: expected the system to be little-endian!';

function callRuntimeCallbacks(callbacks) {
  while(callbacks.length > 0) {
    var callback = callbacks.shift();
    if (typeof callback == 'function') {
      callback();
      continue;
    }
    var func = callback.func;
    if (typeof func === 'number') {
      if (callback.arg === undefined) {
        Module['dynCall_v'](func);
      } else {
        Module['dynCall_vi'](func, callback.arg);
      }
    } else {
      func(callback.arg === undefined ? null : callback.arg);
    }
  }
}

var __ATPRERUN__  = []; // functions called before the runtime is initialized
var __ATINIT__    = []; // functions called during startup
var __ATMAIN__    = []; // functions called when main() is to be run
var __ATEXIT__    = []; // functions called during shutdown
var __ATPOSTRUN__ = []; // functions called after the main() is called

var runtimeInitialized = false;
var runtimeExited = false;


function preRun() {
  // compatibility - merge in anything from Module['preRun'] at this time
  if (Module['preRun']) {
    if (typeof Module['preRun'] == 'function') Module['preRun'] = [Module['preRun']];
    while (Module['preRun'].length) {
      addOnPreRun(Module['preRun'].shift());
    }
  }
  callRuntimeCallbacks(__ATPRERUN__);
}

function initRuntime() {
  checkStackCookie();
  assert(!runtimeInitialized);
  runtimeInitialized = true;
  
  callRuntimeCallbacks(__ATINIT__);
}

function preMain() {
  checkStackCookie();
  
  callRuntimeCallbacks(__ATMAIN__);
}

function exitRuntime() {
  checkStackCookie();
  runtimeExited = true;
}

function postRun() {
  checkStackCookie();
  // compatibility - merge in anything from Module['postRun'] at this time
  if (Module['postRun']) {
    if (typeof Module['postRun'] == 'function') Module['postRun'] = [Module['postRun']];
    while (Module['postRun'].length) {
      addOnPostRun(Module['postRun'].shift());
    }
  }
  callRuntimeCallbacks(__ATPOSTRUN__);
}

function addOnPreRun(cb) {
  __ATPRERUN__.unshift(cb);
}

function addOnInit(cb) {
  __ATINIT__.unshift(cb);
}

function addOnPreMain(cb) {
  __ATMAIN__.unshift(cb);
}

function addOnExit(cb) {
}

function addOnPostRun(cb) {
  __ATPOSTRUN__.unshift(cb);
}

function unSign(value, bits, ignore) {
  if (value >= 0) {
    return value;
  }
  return bits <= 32 ? 2*Math.abs(1 << (bits-1)) + value // Need some trickery, since if bits == 32, we are right at the limit of the bits JS uses in bitshifts
                    : Math.pow(2, bits)         + value;
}
function reSign(value, bits, ignore) {
  if (value <= 0) {
    return value;
  }
  var half = bits <= 32 ? Math.abs(1 << (bits-1)) // abs is needed if bits == 32
                        : Math.pow(2, bits-1);
  if (value >= half && (bits <= 32 || value > half)) { // for huge values, we can hit the precision limit and always get true here. so don't do that
                                                       // but, in general there is no perfect solution here. With 64-bit ints, we get rounding and errors
                                                       // TODO: In i64 mode 1, resign the two parts separately and safely
    value = -2*half + value; // Cannot bitshift half, as it may be at the limit of the bits JS uses in bitshifts
  }
  return value;
}


assert(Math.imul, 'This browser does not support Math.imul(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.fround, 'This browser does not support Math.fround(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.clz32, 'This browser does not support Math.clz32(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.trunc, 'This browser does not support Math.trunc(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');

var Math_abs = Math.abs;
var Math_cos = Math.cos;
var Math_sin = Math.sin;
var Math_tan = Math.tan;
var Math_acos = Math.acos;
var Math_asin = Math.asin;
var Math_atan = Math.atan;
var Math_atan2 = Math.atan2;
var Math_exp = Math.exp;
var Math_log = Math.log;
var Math_sqrt = Math.sqrt;
var Math_ceil = Math.ceil;
var Math_floor = Math.floor;
var Math_pow = Math.pow;
var Math_imul = Math.imul;
var Math_fround = Math.fround;
var Math_round = Math.round;
var Math_min = Math.min;
var Math_max = Math.max;
var Math_clz32 = Math.clz32;
var Math_trunc = Math.trunc;



// A counter of dependencies for calling run(). If we need to
// do asynchronous work before running, increment this and
// decrement it. Incrementing must happen in a place like
// Module.preRun (used by emcc to add file preloading).
// Note that you can add dependencies in preRun, even though
// it happens right before run - run will be postponed until
// the dependencies are met.
var runDependencies = 0;
var runDependencyWatcher = null;
var dependenciesFulfilled = null; // overridden to take different actions when all run dependencies are fulfilled
var runDependencyTracking = {};

function getUniqueRunDependency(id) {
  var orig = id;
  while (1) {
    if (!runDependencyTracking[id]) return id;
    id = orig + Math.random();
  }
  return id;
}

function addRunDependency(id) {
  runDependencies++;
  if (Module['monitorRunDependencies']) {
    Module['monitorRunDependencies'](runDependencies);
  }
  if (id) {
    assert(!runDependencyTracking[id]);
    runDependencyTracking[id] = 1;
    if (runDependencyWatcher === null && typeof setInterval !== 'undefined') {
      // Check for missing dependencies every few seconds
      runDependencyWatcher = setInterval(function() {
        if (ABORT) {
          clearInterval(runDependencyWatcher);
          runDependencyWatcher = null;
          return;
        }
        var shown = false;
        for (var dep in runDependencyTracking) {
          if (!shown) {
            shown = true;
            err('still waiting on run dependencies:');
          }
          err('dependency: ' + dep);
        }
        if (shown) {
          err('(end of list)');
        }
      }, 10000);
    }
  } else {
    err('warning: run dependency added without ID');
  }
}

function removeRunDependency(id) {
  runDependencies--;
  if (Module['monitorRunDependencies']) {
    Module['monitorRunDependencies'](runDependencies);
  }
  if (id) {
    assert(runDependencyTracking[id]);
    delete runDependencyTracking[id];
  } else {
    err('warning: run dependency removed without ID');
  }
  if (runDependencies == 0) {
    if (runDependencyWatcher !== null) {
      clearInterval(runDependencyWatcher);
      runDependencyWatcher = null;
    }
    if (dependenciesFulfilled) {
      var callback = dependenciesFulfilled;
      dependenciesFulfilled = null;
      callback(); // can add another dependenciesFulfilled
    }
  }
}

Module["preloadedImages"] = {}; // maps url to image data
Module["preloadedAudios"] = {}; // maps url to audio data


var memoryInitializer = null;



// show errors on likely calls to FS when it was not included
var FS = {
  error: function() {
    abort('Filesystem support (FS) was not included. The problem is that you are using files from JS, but files were not used from C/C++, so filesystem support was not auto-included. You can force-include filesystem support with  -s FORCE_FILESYSTEM=1');
  },
  init: function() { FS.error() },
  createDataFile: function() { FS.error() },
  createPreloadedFile: function() { FS.error() },
  createLazyFile: function() { FS.error() },
  open: function() { FS.error() },
  mkdev: function() { FS.error() },
  registerDevice: function() { FS.error() },
  analyzePath: function() { FS.error() },
  loadFilesFromDB: function() { FS.error() },

  ErrnoError: function ErrnoError() { FS.error() },
};
Module['FS_createDataFile'] = FS.createDataFile;
Module['FS_createPreloadedFile'] = FS.createPreloadedFile;



// Copyright 2017 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

// Prefix of data URIs emitted by SINGLE_FILE and related options.
var dataURIPrefix = 'data:application/octet-stream;base64,';

// Indicates whether filename is a base64 data URI.
function isDataURI(filename) {
  return String.prototype.startsWith ?
      filename.startsWith(dataURIPrefix) :
      filename.indexOf(dataURIPrefix) === 0;
}





// Globals used by JS i64 conversions
var tempDouble;
var tempI64;

// === Body ===

var ASM_CONSTS = [];





// STATICTOP = STATIC_BASE + 2936;
/* global initializers */ /*__ATINIT__.push();*/


memoryInitializer = "data:application/octet-stream;base64,AAAAAAAAAAARAAoAERERAAAAAAUAAAAAAAAJAAAAAAsAAAAAAAAAABEADwoREREDCgcAARMJCwsAAAkGCwAACwAGEQAAABEREQAAAAAAAAAAAAAAAAAAAAALAAAAAAAAAAARAAoKERERAAoAAAIACQsAAAAJAAsAAAsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAADAAAAAAMAAAAAAkMAAAAAAAMAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAAA0AAAAEDQAAAAAJDgAAAAAADgAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAPAAAAAA8AAAAACRAAAAAAABAAABAAABIAAAASEhIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEgAAABISEgAAAAAAAAkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsAAAAAAAAAAAAAAAoAAAAACgAAAAAJCwAAAAAACwAACwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAMAAAAAAwAAAAACQwAAAAAAAwAAAwAADAxMjM0NTY3ODlBQkNERUYFAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAwAAAFgEAAAABAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAK/////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwAQAA8AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABGb3IgR29kIHNvIGxvdmVkIHRoZSB3b3JsZCwgdGhhdCBoZSBnYXZlIGhpcyBvbmx5IGJlZ290dGVuIFNvbiwgdGhhdCB3aG9zb2V2ZXIgYmVsaWV2ZXRoIGluIGhpbSBzaG91bGQgbm90IHBlcmlzaCwgYnV0IGhhdmUgZXZlcmxhc3RpbmcgbGlmZS4KAC0rICAgMFgweAAobnVsbCkALTBYKzBYIDBYLTB4KzB4IDB4AGluZgBJTkYAbmFuAE5BTgAu";





/* no memory initializer */
var tempDoublePtr = 2928
assert(tempDoublePtr % 8 == 0);

function copyTempFloat(ptr) { // functions, because inlining this code increases code size too much
  HEAP8[tempDoublePtr] = HEAP8[ptr];
  HEAP8[tempDoublePtr+1] = HEAP8[ptr+1];
  HEAP8[tempDoublePtr+2] = HEAP8[ptr+2];
  HEAP8[tempDoublePtr+3] = HEAP8[ptr+3];
}

function copyTempDouble(ptr) {
  HEAP8[tempDoublePtr] = HEAP8[ptr];
  HEAP8[tempDoublePtr+1] = HEAP8[ptr+1];
  HEAP8[tempDoublePtr+2] = HEAP8[ptr+2];
  HEAP8[tempDoublePtr+3] = HEAP8[ptr+3];
  HEAP8[tempDoublePtr+4] = HEAP8[ptr+4];
  HEAP8[tempDoublePtr+5] = HEAP8[ptr+5];
  HEAP8[tempDoublePtr+6] = HEAP8[ptr+6];
  HEAP8[tempDoublePtr+7] = HEAP8[ptr+7];
}

// {{PRE_LIBRARY}}


  function ___lock() {}

  
    

  
  
  var PATH={splitPath:function (filename) {
        var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
        return splitPathRe.exec(filename).slice(1);
      },normalizeArray:function (parts, allowAboveRoot) {
        // if the path tries to go above the root, `up` ends up > 0
        var up = 0;
        for (var i = parts.length - 1; i >= 0; i--) {
          var last = parts[i];
          if (last === '.') {
            parts.splice(i, 1);
          } else if (last === '..') {
            parts.splice(i, 1);
            up++;
          } else if (up) {
            parts.splice(i, 1);
            up--;
          }
        }
        // if the path is allowed to go above the root, restore leading ..s
        if (allowAboveRoot) {
          for (; up; up--) {
            parts.unshift('..');
          }
        }
        return parts;
      },normalize:function (path) {
        var isAbsolute = path.charAt(0) === '/',
            trailingSlash = path.substr(-1) === '/';
        // Normalize the path
        path = PATH.normalizeArray(path.split('/').filter(function(p) {
          return !!p;
        }), !isAbsolute).join('/');
        if (!path && !isAbsolute) {
          path = '.';
        }
        if (path && trailingSlash) {
          path += '/';
        }
        return (isAbsolute ? '/' : '') + path;
      },dirname:function (path) {
        var result = PATH.splitPath(path),
            root = result[0],
            dir = result[1];
        if (!root && !dir) {
          // No dirname whatsoever
          return '.';
        }
        if (dir) {
          // It has a dirname, strip trailing slash
          dir = dir.substr(0, dir.length - 1);
        }
        return root + dir;
      },basename:function (path) {
        // EMSCRIPTEN return '/'' for '/', not an empty string
        if (path === '/') return '/';
        var lastSlash = path.lastIndexOf('/');
        if (lastSlash === -1) return path;
        return path.substr(lastSlash+1);
      },extname:function (path) {
        return PATH.splitPath(path)[3];
      },join:function () {
        var paths = Array.prototype.slice.call(arguments, 0);
        return PATH.normalize(paths.join('/'));
      },join2:function (l, r) {
        return PATH.normalize(l + '/' + r);
      }};var SYSCALLS={buffers:[null,[],[]],printChar:function (stream, curr) {
        var buffer = SYSCALLS.buffers[stream];
        assert(buffer);
        if (curr === 0 || curr === 10) {
          (stream === 1 ? out : err)(UTF8ArrayToString(buffer, 0));
          buffer.length = 0;
        } else {
          buffer.push(curr);
        }
      },varargs:0,get:function (varargs) {
        SYSCALLS.varargs += 4;
        var ret = HEAP32[(((SYSCALLS.varargs)-(4))>>2)];
        return ret;
      },getStr:function () {
        var ret = UTF8ToString(SYSCALLS.get());
        return ret;
      },get64:function () {
        var low = SYSCALLS.get(), high = SYSCALLS.get();
        if (low >= 0) assert(high === 0);
        else assert(high === -1);
        return low;
      },getZero:function () {
        assert(SYSCALLS.get() === 0);
      }};function ___syscall140(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // llseek
      var stream = SYSCALLS.getStreamFromFD(), offset_high = SYSCALLS.get(), offset_low = SYSCALLS.get(), result = SYSCALLS.get(), whence = SYSCALLS.get();
      abort('it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM');
      return 0;
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  
  function flush_NO_FILESYSTEM() {
      // flush anything remaining in the buffers during shutdown
      var fflush = Module["_fflush"];
      if (fflush) fflush(0);
      var buffers = SYSCALLS.buffers;
      if (buffers[1].length) SYSCALLS.printChar(1, 10);
      if (buffers[2].length) SYSCALLS.printChar(2, 10);
    }function ___syscall146(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // writev
      // hack to support printf in SYSCALLS_REQUIRE_FILESYSTEM=0
      var stream = SYSCALLS.get(), iov = SYSCALLS.get(), iovcnt = SYSCALLS.get();
      var ret = 0;
      for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAP32[(((iov)+(i*8))>>2)];
        var len = HEAP32[(((iov)+(i*8 + 4))>>2)];
        for (var j = 0; j < len; j++) {
          SYSCALLS.printChar(stream, HEAPU8[ptr+j]);
        }
        ret += len;
      }
      return ret;
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  function ___syscall54(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // ioctl
      return 0;
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  function ___syscall6(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // close
      var stream = SYSCALLS.getStreamFromFD();
      abort('it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM');
      return 0;
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  
  
   
  
   
  
     

  function ___unlock() {}

   

   

  function _emscripten_get_heap_size() {
      return HEAP8.length;
    }



  
  function _emscripten_memcpy_big(dest, src, num) {
      HEAPU8.set(HEAPU8.subarray(src, src+num), dest);
    }
  
   

   

  
  function ___setErrNo(value) {
      if (Module['___errno_location']) HEAP32[((Module['___errno_location']())>>2)]=value;
      else err('failed to set errno from JS');
      return value;
    }
  
  
  function abortOnCannotGrowMemory(requestedSize) {
      abort('Cannot enlarge memory arrays to size ' + requestedSize + ' bytes (OOM). Either (1) compile with  -s TOTAL_MEMORY=X  with X higher than the current value ' + HEAP8.length + ', (2) compile with  -s ALLOW_MEMORY_GROWTH=1  which allows increasing the size at runtime but prevents some optimizations, (3) set Module.TOTAL_MEMORY to a higher value before the program runs, or (4) if you want malloc to return NULL (0) instead of this abort, compile with  -s ABORTING_MALLOC=0 ');
    }function _emscripten_resize_heap(requestedSize) {
      abortOnCannotGrowMemory(requestedSize);
    } 
var ASSERTIONS = true;

// Copyright 2017 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

/** @type {function(string, boolean=, number=)} */
function intArrayFromString(stringy, dontAddNull, length) {
  var len = length > 0 ? length : lengthBytesUTF8(stringy)+1;
  var u8array = new Array(len);
  var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
  if (dontAddNull) u8array.length = numBytesWritten;
  return u8array;
}

function intArrayToString(array) {
  var ret = [];
  for (var i = 0; i < array.length; i++) {
    var chr = array[i];
    if (chr > 0xFF) {
      if (ASSERTIONS) {
        assert(false, 'Character code ' + chr + ' (' + String.fromCharCode(chr) + ')  at offset ' + i + ' not in 0x00-0xFF.');
      }
      chr &= 0xFF;
    }
    ret.push(String.fromCharCode(chr));
  }
  return ret.join('');
}


// Copied from https://github.com/strophe/strophejs/blob/e06d027/src/polyfills.js#L149

// This code was written by Tyler Akins and has been placed in the
// public domain.  It would be nice if you left this header intact.
// Base64 code from Tyler Akins -- http://rumkin.com

/**
 * Decodes a base64 string.
 * @param {String} input The string to decode.
 */
var decodeBase64 = typeof atob === 'function' ? atob : function (input) {
  var keyStr = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

  var output = '';
  var chr1, chr2, chr3;
  var enc1, enc2, enc3, enc4;
  var i = 0;
  // remove all characters that are not A-Z, a-z, 0-9, +, /, or =
  input = input.replace(/[^A-Za-z0-9\+\/\=]/g, '');
  do {
    enc1 = keyStr.indexOf(input.charAt(i++));
    enc2 = keyStr.indexOf(input.charAt(i++));
    enc3 = keyStr.indexOf(input.charAt(i++));
    enc4 = keyStr.indexOf(input.charAt(i++));

    chr1 = (enc1 << 2) | (enc2 >> 4);
    chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
    chr3 = ((enc3 & 3) << 6) | enc4;

    output = output + String.fromCharCode(chr1);

    if (enc3 !== 64) {
      output = output + String.fromCharCode(chr2);
    }
    if (enc4 !== 64) {
      output = output + String.fromCharCode(chr3);
    }
  } while (i < input.length);
  return output;
};

// Converts a string of base64 into a byte array.
// Throws error on invalid input.
function intArrayFromBase64(s) {
  if (typeof ENVIRONMENT_IS_NODE === 'boolean' && ENVIRONMENT_IS_NODE) {
    var buf;
    try {
      buf = Buffer.from(s, 'base64');
    } catch (_) {
      buf = new Buffer(s, 'base64');
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  try {
    var decoded = decodeBase64(s);
    var bytes = new Uint8Array(decoded.length);
    for (var i = 0 ; i < decoded.length ; ++i) {
      bytes[i] = decoded.charCodeAt(i);
    }
    return bytes;
  } catch (_) {
    throw new Error('Converting base64 string to bytes failed.');
  }
}

// If filename is a base64 data URI, parses and returns data (Buffer on node,
// Uint8Array otherwise). If filename is not a base64 data URI, returns undefined.
function tryParseAsDataURI(filename) {
  if (!isDataURI(filename)) {
    return;
  }

  return intArrayFromBase64(filename.slice(dataURIPrefix.length));
}


// ASM_LIBRARY EXTERN PRIMITIVES: Math_imul,Math_clz32,Int8Array,Int32Array


function nullFunc_ii(x) { err("Invalid function pointer called with signature 'ii'. Perhaps this is an invalid value (e.g. caused by calling a virtual method on a NULL pointer)? Or calling a function with an incorrect type, which will fail? (it is worth building your source files with -Werror (warnings are errors), as warnings can indicate undefined behavior which can cause this)");  err("Build with ASSERTIONS=2 for more info.");abort(x) }

function nullFunc_iidiiii(x) { err("Invalid function pointer called with signature 'iidiiii'. Perhaps this is an invalid value (e.g. caused by calling a virtual method on a NULL pointer)? Or calling a function with an incorrect type, which will fail? (it is worth building your source files with -Werror (warnings are errors), as warnings can indicate undefined behavior which can cause this)");  err("Build with ASSERTIONS=2 for more info.");abort(x) }

function nullFunc_iiii(x) { err("Invalid function pointer called with signature 'iiii'. Perhaps this is an invalid value (e.g. caused by calling a virtual method on a NULL pointer)? Or calling a function with an incorrect type, which will fail? (it is worth building your source files with -Werror (warnings are errors), as warnings can indicate undefined behavior which can cause this)");  err("Build with ASSERTIONS=2 for more info.");abort(x) }

function nullFunc_iiiii(x) { err("Invalid function pointer called with signature 'iiiii'. Perhaps this is an invalid value (e.g. caused by calling a virtual method on a NULL pointer)? Or calling a function with an incorrect type, which will fail? (it is worth building your source files with -Werror (warnings are errors), as warnings can indicate undefined behavior which can cause this)");  err("Build with ASSERTIONS=2 for more info.");abort(x) }

function nullFunc_vii(x) { err("Invalid function pointer called with signature 'vii'. Perhaps this is an invalid value (e.g. caused by calling a virtual method on a NULL pointer)? Or calling a function with an incorrect type, which will fail? (it is worth building your source files with -Werror (warnings are errors), as warnings can indicate undefined behavior which can cause this)");  err("Build with ASSERTIONS=2 for more info.");abort(x) }

var asmGlobalArg = { "Math": Math, "Int8Array": Int8Array, "Int16Array": Int16Array, "Int32Array": Int32Array, "Uint8Array": Uint8Array, "Uint16Array": Uint16Array, "Float32Array": Float32Array, "Float64Array": Float64Array }

var asmLibraryArg = {
  "abort": abort,
  "setTempRet0": setTempRet0,
  "getTempRet0": getTempRet0,
  "abortStackOverflow": abortStackOverflow,
  "nullFunc_ii": nullFunc_ii,
  "nullFunc_iidiiii": nullFunc_iidiiii,
  "nullFunc_iiii": nullFunc_iiii,
  "nullFunc_iiiii": nullFunc_iiiii,
  "nullFunc_vii": nullFunc_vii,
  "___lock": ___lock,
  "___setErrNo": ___setErrNo,
  "___syscall140": ___syscall140,
  "___syscall146": ___syscall146,
  "___syscall54": ___syscall54,
  "___syscall6": ___syscall6,
  "___unlock": ___unlock,
  "_emscripten_get_heap_size": _emscripten_get_heap_size,
  "_emscripten_memcpy_big": _emscripten_memcpy_big,
  "_emscripten_resize_heap": _emscripten_resize_heap,
  "abortOnCannotGrowMemory": abortOnCannotGrowMemory,
  "flush_NO_FILESYSTEM": flush_NO_FILESYSTEM,
  "tempDoublePtr": tempDoublePtr,
  "DYNAMICTOP_PTR": DYNAMICTOP_PTR
}
// EMSCRIPTEN_START_ASM
var asm = (/** @suppress {uselessCode} */ function(global, env, buffer) {
'almost asm';

  var HEAP8 = new global.Int8Array(buffer),
  HEAP16 = new global.Int16Array(buffer),
  HEAP32 = new global.Int32Array(buffer),
  HEAPU8 = new global.Uint8Array(buffer),
  HEAPU16 = new global.Uint16Array(buffer),
  HEAPF32 = new global.Float32Array(buffer),
  HEAPF64 = new global.Float64Array(buffer),
  tempDoublePtr=env.tempDoublePtr|0,
  DYNAMICTOP_PTR=env.DYNAMICTOP_PTR|0,
  __THREW__ = 0,
  threwValue = 0,
  setjmpId = 0,
  tempInt = 0,
  tempBigInt = 0,
  tempBigIntS = 0,
  tempValue = 0,
  tempDouble = 0.0,
  Math_imul=global.Math.imul,
  Math_clz32=global.Math.clz32,
  abort=env.abort,
  setTempRet0=env.setTempRet0,
  getTempRet0=env.getTempRet0,
  abortStackOverflow=env.abortStackOverflow,
  nullFunc_ii=env.nullFunc_ii,
  nullFunc_iidiiii=env.nullFunc_iidiiii,
  nullFunc_iiii=env.nullFunc_iiii,
  nullFunc_iiiii=env.nullFunc_iiiii,
  nullFunc_vii=env.nullFunc_vii,
  ___lock=env.___lock,
  ___setErrNo=env.___setErrNo,
  ___syscall140=env.___syscall140,
  ___syscall146=env.___syscall146,
  ___syscall54=env.___syscall54,
  ___syscall6=env.___syscall6,
  ___unlock=env.___unlock,
  _emscripten_get_heap_size=env._emscripten_get_heap_size,
  _emscripten_memcpy_big=env._emscripten_memcpy_big,
  _emscripten_resize_heap=env._emscripten_resize_heap,
  abortOnCannotGrowMemory=env.abortOnCannotGrowMemory,
  flush_NO_FILESYSTEM=env.flush_NO_FILESYSTEM,
  STACKTOP = 2944,
  STACK_MAX = 5245824,
  tempFloat = 0.0;

// EMSCRIPTEN_START_FUNCS

function stackAlloc(size) {
  size = size|0;
  var ret = 0;
  ret = STACKTOP;
  STACKTOP = (STACKTOP + size)|0;
  STACKTOP = (STACKTOP + 15)&-16;
    if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(size|0);

  return ret|0;
}
function stackSave() {
  return STACKTOP|0;
}
function stackRestore(top) {
  top = top|0;
  STACKTOP = top;
}
function establishStackSpace(stackBase, stackMax) {
  stackBase = stackBase|0;
  stackMax = stackMax|0;
  STACKTOP = stackBase;
  STACK_MAX = stackMax;
}

function _main($argc,$argv) {
 $argc = $argc|0;
 $argv = $argv|0;
 var $argc$addr = 0, $argv$addr = 0, $retval = 0, $vararg_buffer = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $vararg_buffer = sp;
 $retval = 0;
 $argc$addr = $argc;
 $argv$addr = $argv;
 (_printf(892,$vararg_buffer)|0);
 STACKTOP = sp;return 0;
}
function ___stdio_close($f) {
 $f = $f|0;
 var $0 = 0, $call = 0, $call1 = 0, $call2 = 0, $fd = 0, $vararg_buffer = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $vararg_buffer = sp;
 $fd = ((($f)) + 60|0);
 $0 = HEAP32[$fd>>2]|0;
 $call = (_dummy_560($0)|0);
 HEAP32[$vararg_buffer>>2] = $call;
 $call1 = (___syscall6(6,($vararg_buffer|0))|0);
 $call2 = (___syscall_ret($call1)|0);
 STACKTOP = sp;return ($call2|0);
}
function ___stdio_write($f,$buf,$len) {
 $f = $f|0;
 $buf = $buf|0;
 $len = $len|0;
 var $0 = 0, $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $add = 0, $add$ptr = 0, $add$ptr32 = 0, $buf8 = 0, $buf_size = 0, $call = 0;
 var $call40 = 0, $call7 = 0, $call741 = 0, $call746 = 0, $cmp = 0, $cmp12 = 0, $cmp17 = 0, $cmp24 = 0, $cmp42 = 0, $cnt$0 = 0, $dec = 0, $fd = 0, $incdec$ptr = 0, $iov$043 = 0, $iov$1 = 0, $iov_base2 = 0, $iov_len = 0, $iov_len19 = 0, $iov_len23 = 0, $iov_len3 = 0;
 var $iov_len36 = 0, $iovcnt$045 = 0, $iovcnt$1 = 0, $iovs = 0, $or = 0, $rem$044 = 0, $retval$0 = 0, $sub = 0, $sub$ptr$sub = 0, $sub21 = 0, $sub28 = 0, $sub37 = 0, $vararg_buffer = 0, $vararg_buffer3 = 0, $vararg_ptr1 = 0, $vararg_ptr2 = 0, $vararg_ptr6 = 0, $vararg_ptr7 = 0, $wbase = 0, $wend = 0;
 var $wend14 = 0, $wpos = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 48|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(48|0);
 $vararg_buffer3 = sp + 32|0;
 $vararg_buffer = sp + 16|0;
 $iovs = sp;
 $wbase = ((($f)) + 28|0);
 $0 = HEAP32[$wbase>>2]|0;
 HEAP32[$iovs>>2] = $0;
 $iov_len = ((($iovs)) + 4|0);
 $wpos = ((($f)) + 20|0);
 $1 = HEAP32[$wpos>>2]|0;
 $sub$ptr$sub = (($1) - ($0))|0;
 HEAP32[$iov_len>>2] = $sub$ptr$sub;
 $iov_base2 = ((($iovs)) + 8|0);
 HEAP32[$iov_base2>>2] = $buf;
 $iov_len3 = ((($iovs)) + 12|0);
 HEAP32[$iov_len3>>2] = $len;
 $add = (($sub$ptr$sub) + ($len))|0;
 $fd = ((($f)) + 60|0);
 $2 = HEAP32[$fd>>2]|0;
 $3 = $iovs;
 HEAP32[$vararg_buffer>>2] = $2;
 $vararg_ptr1 = ((($vararg_buffer)) + 4|0);
 HEAP32[$vararg_ptr1>>2] = $3;
 $vararg_ptr2 = ((($vararg_buffer)) + 8|0);
 HEAP32[$vararg_ptr2>>2] = 2;
 $call40 = (___syscall146(146,($vararg_buffer|0))|0);
 $call741 = (___syscall_ret($call40)|0);
 $cmp42 = ($add|0)==($call741|0);
 L1: do {
  if ($cmp42) {
   label = 3;
  } else {
   $call746 = $call741;$iov$043 = $iovs;$iovcnt$045 = 2;$rem$044 = $add;
   while(1) {
    $cmp12 = ($call746|0)<(0);
    if ($cmp12) {
     break;
    }
    $sub21 = (($rem$044) - ($call746))|0;
    $iov_len23 = ((($iov$043)) + 4|0);
    $9 = HEAP32[$iov_len23>>2]|0;
    $cmp24 = ($call746>>>0)>($9>>>0);
    $incdec$ptr = ((($iov$043)) + 8|0);
    $iov$1 = $cmp24 ? $incdec$ptr : $iov$043;
    $dec = $cmp24 << 31 >> 31;
    $iovcnt$1 = (($iovcnt$045) + ($dec))|0;
    $sub28 = $cmp24 ? $9 : 0;
    $cnt$0 = (($call746) - ($sub28))|0;
    $10 = HEAP32[$iov$1>>2]|0;
    $add$ptr32 = (($10) + ($cnt$0)|0);
    HEAP32[$iov$1>>2] = $add$ptr32;
    $iov_len36 = ((($iov$1)) + 4|0);
    $11 = HEAP32[$iov_len36>>2]|0;
    $sub37 = (($11) - ($cnt$0))|0;
    HEAP32[$iov_len36>>2] = $sub37;
    $12 = HEAP32[$fd>>2]|0;
    $13 = $iov$1;
    HEAP32[$vararg_buffer3>>2] = $12;
    $vararg_ptr6 = ((($vararg_buffer3)) + 4|0);
    HEAP32[$vararg_ptr6>>2] = $13;
    $vararg_ptr7 = ((($vararg_buffer3)) + 8|0);
    HEAP32[$vararg_ptr7>>2] = $iovcnt$1;
    $call = (___syscall146(146,($vararg_buffer3|0))|0);
    $call7 = (___syscall_ret($call)|0);
    $cmp = ($sub21|0)==($call7|0);
    if ($cmp) {
     label = 3;
     break L1;
    } else {
     $call746 = $call7;$iov$043 = $iov$1;$iovcnt$045 = $iovcnt$1;$rem$044 = $sub21;
    }
   }
   $wend14 = ((($f)) + 16|0);
   HEAP32[$wend14>>2] = 0;
   HEAP32[$wbase>>2] = 0;
   HEAP32[$wpos>>2] = 0;
   $7 = HEAP32[$f>>2]|0;
   $or = $7 | 32;
   HEAP32[$f>>2] = $or;
   $cmp17 = ($iovcnt$045|0)==(2);
   if ($cmp17) {
    $retval$0 = 0;
   } else {
    $iov_len19 = ((($iov$043)) + 4|0);
    $8 = HEAP32[$iov_len19>>2]|0;
    $sub = (($len) - ($8))|0;
    $retval$0 = $sub;
   }
  }
 } while(0);
 if ((label|0) == 3) {
  $buf8 = ((($f)) + 44|0);
  $4 = HEAP32[$buf8>>2]|0;
  $buf_size = ((($f)) + 48|0);
  $5 = HEAP32[$buf_size>>2]|0;
  $add$ptr = (($4) + ($5)|0);
  $wend = ((($f)) + 16|0);
  HEAP32[$wend>>2] = $add$ptr;
  $6 = $4;
  HEAP32[$wbase>>2] = $6;
  HEAP32[$wpos>>2] = $6;
  $retval$0 = $len;
 }
 STACKTOP = sp;return ($retval$0|0);
}
function ___stdio_seek($f,$0,$1,$whence) {
 $f = $f|0;
 $0 = $0|0;
 $1 = $1|0;
 $whence = $whence|0;
 var $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $call = 0, $call2 = 0, $cmp = 0, $fd = 0, $ret = 0, $vararg_buffer = 0;
 var $vararg_ptr1 = 0, $vararg_ptr2 = 0, $vararg_ptr3 = 0, $vararg_ptr4 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 32|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(32|0);
 $vararg_buffer = sp + 8|0;
 $ret = sp;
 $fd = ((($f)) + 60|0);
 $2 = HEAP32[$fd>>2]|0;
 $3 = $ret;
 HEAP32[$vararg_buffer>>2] = $2;
 $vararg_ptr1 = ((($vararg_buffer)) + 4|0);
 HEAP32[$vararg_ptr1>>2] = $1;
 $vararg_ptr2 = ((($vararg_buffer)) + 8|0);
 HEAP32[$vararg_ptr2>>2] = $0;
 $vararg_ptr3 = ((($vararg_buffer)) + 12|0);
 HEAP32[$vararg_ptr3>>2] = $3;
 $vararg_ptr4 = ((($vararg_buffer)) + 16|0);
 HEAP32[$vararg_ptr4>>2] = $whence;
 $call = (___syscall140(140,($vararg_buffer|0))|0);
 $call2 = (___syscall_ret($call)|0);
 $cmp = ($call2|0)<(0);
 if ($cmp) {
  $10 = $ret;
  $11 = $10;
  HEAP32[$11>>2] = -1;
  $12 = (($10) + 4)|0;
  $13 = $12;
  HEAP32[$13>>2] = -1;
  $14 = -1;$15 = -1;
 } else {
  $4 = $ret;
  $5 = $4;
  $6 = HEAP32[$5>>2]|0;
  $7 = (($4) + 4)|0;
  $8 = $7;
  $9 = HEAP32[$8>>2]|0;
  $14 = $9;$15 = $6;
 }
 setTempRet0(($14) | 0);
 STACKTOP = sp;return ($15|0);
}
function ___syscall_ret($r) {
 $r = $r|0;
 var $call = 0, $cmp = 0, $retval$0 = 0, $sub = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $cmp = ($r>>>0)>(4294963200);
 if ($cmp) {
  $sub = (0 - ($r))|0;
  $call = (___errno_location()|0);
  HEAP32[$call>>2] = $sub;
  $retval$0 = -1;
 } else {
  $retval$0 = $r;
 }
 return ($retval$0|0);
}
function ___errno_location() {
 var label = 0, sp = 0;
 sp = STACKTOP;
 return (2208|0);
}
function _dummy_560($fd) {
 $fd = $fd|0;
 var label = 0, sp = 0;
 sp = STACKTOP;
 return ($fd|0);
}
function ___stdout_write($f,$buf,$len) {
 $f = $f|0;
 $buf = $buf|0;
 $len = $len|0;
 var $0 = 0, $1 = 0, $2 = 0, $and = 0, $call = 0, $call3 = 0, $fd = 0, $lbf = 0, $tobool = 0, $tobool2 = 0, $vararg_buffer = 0, $vararg_ptr1 = 0, $vararg_ptr2 = 0, $write = 0, $wsz = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 32|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(32|0);
 $vararg_buffer = sp;
 $wsz = sp + 16|0;
 $write = ((($f)) + 36|0);
 HEAP32[$write>>2] = 4;
 $0 = HEAP32[$f>>2]|0;
 $and = $0 & 64;
 $tobool = ($and|0)==(0);
 if ($tobool) {
  $fd = ((($f)) + 60|0);
  $1 = HEAP32[$fd>>2]|0;
  $2 = $wsz;
  HEAP32[$vararg_buffer>>2] = $1;
  $vararg_ptr1 = ((($vararg_buffer)) + 4|0);
  HEAP32[$vararg_ptr1>>2] = 21523;
  $vararg_ptr2 = ((($vararg_buffer)) + 8|0);
  HEAP32[$vararg_ptr2>>2] = $2;
  $call = (___syscall54(54,($vararg_buffer|0))|0);
  $tobool2 = ($call|0)==(0);
  if (!($tobool2)) {
   $lbf = ((($f)) + 75|0);
   HEAP8[$lbf>>0] = -1;
  }
 }
 $call3 = (___stdio_write($f,$buf,$len)|0);
 STACKTOP = sp;return ($call3|0);
}
function _isdigit($c) {
 $c = $c|0;
 var $cmp = 0, $conv = 0, $sub = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $sub = (($c) + -48)|0;
 $cmp = ($sub>>>0)<(10);
 $conv = $cmp&1;
 return ($conv|0);
}
function _vfprintf($f,$fmt,$ap) {
 $f = $f|0;
 $fmt = $fmt|0;
 $ap = $ap|0;
 var $call = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $call = (___vfprintf_internal($f,$fmt,$ap,5,6)|0);
 return ($call|0);
}
function _fmt_fp($f,$y,$w,$p,$fl,$t) {
 $f = $f|0;
 $y = +$y;
 $w = $w|0;
 $p = $p|0;
 $fl = $fl|0;
 $t = $t|0;
 var $$ = 0, $$pr = 0, $$pr415 = 0, $$pre = 0, $$pre517 = 0, $0 = 0, $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0;
 var $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0;
 var $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0;
 var $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0;
 var $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $9 = 0, $a$1$lcssa = 0, $a$1502 = 0, $a$2 = 0, $a$3$lcssa = 0, $a$3488 = 0, $a$5$lcssa = 0, $a$5471 = 0, $a$6 = 0, $a$8 = 0;
 var $a$9 = 0, $add = 0, $add$ptr213 = 0, $add$ptr311 = 0, $add$ptr354 = 0, $add$ptr358 = 0, $add$ptr373 = 0, $add$ptr442 = 0, $add$ptr65 = 0, $add$ptr671 = 0, $add$ptr742 = 0, $add$ptr756 = 0, $add113 = 0, $add150 = 0, $add154 = 0, $add163 = 0, $add165 = 0, $add273 = 0, $add275 = 0, $add284 = 0;
 var $add313 = 0, $add355 = 0, $add410 = 0.0, $add414 = 0, $add477$neg = 0, $add561 = 0, $add608 = 0, $add612 = 0, $add620 = 0, $add653 = 0, $add653$sink524 = 0, $add67 = 0, $add737 = 0, $add810 = 0, $add87 = 0.0, $add90 = 0.0, $and = 0, $and12 = 0, $and134 = 0, $and282 = 0;
 var $and36 = 0, $and379 = 0, $and45 = 0, $and483 = 0, $and610 = 0, $and610$lobit = 0, $and62 = 0, $and702 = 0, $and780 = 0, $arrayidx = 0, $arrayidx117 = 0, $arrayidx251 = 0, $arrayidx453 = 0, $arrayidx489 = 0, $big = 0, $buf = 0, $call55 = 0.0, $carry$0493 = 0, $carry262$0484 = 0, $cmp103 = 0;
 var $cmp127 = 0, $cmp131 = 0, $cmp147 = 0, $cmp196 = 0, $cmp205 = 0, $cmp225 = 0, $cmp225500 = 0, $cmp235 = 0, $cmp235492 = 0, $cmp249 = 0, $cmp249496 = 0, $cmp259 = 0, $cmp259486 = 0, $cmp277 = 0, $cmp277482 = 0, $cmp299 = 0, $cmp308 = 0, $cmp315 = 0, $cmp324 = 0, $cmp324478 = 0;
 var $cmp333 = 0, $cmp338 = 0, $cmp350 = 0, $cmp363 = 0, $cmp363474 = 0, $cmp374 = 0, $cmp38 = 0, $cmp385 = 0, $cmp390 = 0, $cmp403 = 0, $cmp411 = 0, $cmp416 = 0, $cmp416469 = 0, $cmp420 = 0, $cmp433 = 0, $cmp433465 = 0, $cmp443 = 0, $cmp450 = 0, $cmp450$lcssa = 0, $cmp450458 = 0;
 var $cmp470 = 0, $cmp473 = 0, $cmp495 = 0, $cmp495454 = 0, $cmp505 = 0, $cmp528 = 0, $cmp577 = 0, $cmp59 = 0, $cmp614 = 0, $cmp617 = 0, $cmp623 = 0, $cmp636 = 0, $cmp636449 = 0, $cmp660 = 0, $cmp665 = 0, $cmp673 = 0, $cmp678 = 0, $cmp678435 = 0, $cmp686 = 0, $cmp707 = 0;
 var $cmp707430 = 0, $cmp710 = 0, $cmp710431 = 0, $cmp722 = 0, $cmp722427 = 0, $cmp745 = 0, $cmp745442 = 0, $cmp748 = 0, $cmp748443 = 0, $cmp760 = 0, $cmp765 = 0, $cmp770 = 0, $cmp770439 = 0, $cmp777 = 0, $cmp790 = 0, $cmp818 = 0, $cmp82 = 0, $cmp94 = 0, $cond = 0, $cond100 = 0;
 var $cond233 = 0, $cond271 = 0, $cond304 = 0, $cond43 = 0, $cond629 = 0, $cond732 = 0, $cond800 = 0, $conv111 = 0, $conv114 = 0, $conv116 = 0, $conv118393 = 0, $conv121 = 0, $conv123 = 0.0, $conv216 = 0, $conv218 = 0.0, $conv644 = 0, $conv646 = 0, $d$0 = 0, $d$0491 = 0, $d$0494 = 0;
 var $d$1483 = 0, $d$2$lcssa = 0, $d$2470 = 0, $d$4 = 0, $d$5438 = 0, $d$6432 = 0, $d$7444 = 0, $dec = 0, $dec476 = 0, $dec481 = 0, $dec78 = 0, $div274 = 0, $div356 = 0, $div378 = 0, $div384 = 0, $e$0480 = 0, $e$1 = 0, $e$2467 = 0, $e$4 = 0, $e$5 = 0;
 var $e2 = 0, $ebuf0 = 0, $estr$0 = 0, $estr$1$lcssa = 0, $estr$1450 = 0, $estr$2 = 0, $i$0479 = 0, $i$1$lcssa = 0, $i$1475 = 0, $i$2466 = 0, $i$3455 = 0, $inc = 0, $inc425 = 0, $inc438 = 0, $inc468 = 0, $inc500 = 0, $incdec$ptr106 = 0, $incdec$ptr112 = 0, $incdec$ptr115 = 0, $incdec$ptr122 = 0;
 var $incdec$ptr137 = 0, $incdec$ptr217 = 0, $incdec$ptr246 = 0, $incdec$ptr288 = 0, $incdec$ptr292 = 0, $incdec$ptr292520 = 0, $incdec$ptr296 = 0, $incdec$ptr419 = 0, $incdec$ptr423 = 0, $incdec$ptr639 = 0, $incdec$ptr645 = 0, $incdec$ptr647 = 0, $incdec$ptr681 = 0, $incdec$ptr689 = 0, $incdec$ptr698 = 0, $incdec$ptr725 = 0, $incdec$ptr734 = 0, $incdec$ptr763 = 0, $incdec$ptr773 = 0, $incdec$ptr776 = 0;
 var $incdec$ptr808 = 0, $j$0 = 0, $j$0$in476 = 0, $j$1456 = 0, $j$2 = 0, $l$0 = 0, $l$1 = 0, $land$ext$neg = 0, $mul = 0.0, $mul125 = 0.0, $mul202 = 0.0, $mul220 = 0.0, $mul286 = 0, $mul322 = 0, $mul328 = 0, $mul335 = 0, $mul349 = 0, $mul367 = 0, $mul406 = 0.0, $mul407 = 0.0;
 var $mul431 = 0, $mul437 = 0, $mul499 = 0, $mul513 = 0, $mul80 = 0.0, $not$tobool341 = 0, $or = 0, $or$cond = 0, $or$cond1$not = 0, $or$cond2 = 0, $or$cond398 = 0, $or$cond400 = 0, $or$cond409 = 0, $or$cond411 = 0, $or120 = 0, $or504 = 0, $or613 = 0, $p$addr$2 = 0, $p$addr$3 = 0, $p$addr$4$lcssa = 0;
 var $p$addr$4433 = 0, $p$addr$5$lcssa = 0, $p$addr$5445 = 0, $pl$0 = 0, $prefix$0 = 0, $re$1426 = 0, $rem494 = 0, $rem494453 = 0, $round$0425 = 0.0, $round377$1 = 0.0, $s$0 = 0, $s$1 = 0, $s35$0 = 0, $s668$0436 = 0, $s668$1 = 0, $s715$0$lcssa = 0, $s715$0428 = 0, $s753$0 = 0, $s753$1440 = 0, $s753$2 = 0;
 var $scevgep513 = 0, $scevgep513514 = 0, $shl280 = 0, $shr283 = 0, $shr285 = 0, $small$1 = 0.0, $spec$select = 0, $spec$select395 = 0, $spec$select396 = 0, $spec$select396521 = 0, $spec$select396523 = 0, $spec$select397 = 0, $spec$select399 = 0.0, $spec$select401 = 0, $spec$select402 = 0, $spec$select403 = 0, $spec$select405 = 0, $spec$select408 = 0, $spec$select410 = 0, $spec$select412 = 0.0;
 var $spec$select413 = 0, $spec$select414 = 0, $spec$select416 = 0, $spec$select417 = 0, $spec$select418 = 0.0, $spec$select419 = 0.0, $spec$select420 = 0.0, $sub = 0.0, $sub$ptr$div = 0, $sub$ptr$div321 = 0, $sub$ptr$div347 = 0, $sub$ptr$div430 = 0, $sub$ptr$div511 = 0, $sub$ptr$lhs$cast = 0, $sub$ptr$lhs$cast151 = 0, $sub$ptr$lhs$cast160 = 0, $sub$ptr$lhs$cast173$pre$phiZZZZ2D = 0, $sub$ptr$lhs$cast305 = 0, $sub$ptr$lhs$cast344 = 0, $sub$ptr$lhs$cast508 = 0;
 var $sub$ptr$lhs$cast633 = 0, $sub$ptr$lhs$cast694 = 0, $sub$ptr$lhs$cast787 = 0, $sub$ptr$lhs$cast811 = 0, $sub$ptr$rhs$cast$le = 0, $sub$ptr$rhs$cast152 = 0, $sub$ptr$rhs$cast161 = 0, $sub$ptr$rhs$cast174$pre$phiZZZZ2D = 0, $sub$ptr$rhs$cast306 = 0, $sub$ptr$rhs$cast319 = 0, $sub$ptr$rhs$cast345 = 0, $sub$ptr$rhs$cast428 = 0, $sub$ptr$rhs$cast634 = 0, $sub$ptr$rhs$cast634447 = 0, $sub$ptr$rhs$cast649 = 0, $sub$ptr$rhs$cast695 = 0, $sub$ptr$rhs$cast788 = 0, $sub$ptr$rhs$cast812 = 0, $sub$ptr$sub = 0, $sub$ptr$sub145 = 0;
 var $sub$ptr$sub153 = 0, $sub$ptr$sub159 = 0, $sub$ptr$sub162 = 0, $sub$ptr$sub172 = 0, $sub$ptr$sub175 = 0, $sub$ptr$sub307 = 0, $sub$ptr$sub320 = 0, $sub$ptr$sub346 = 0, $sub$ptr$sub429 = 0, $sub$ptr$sub510 = 0, $sub$ptr$sub635 = 0, $sub$ptr$sub635448 = 0, $sub$ptr$sub650 = 0, $sub$ptr$sub650$pn = 0, $sub$ptr$sub696 = 0, $sub$ptr$sub789 = 0, $sub$ptr$sub813 = 0, $sub124 = 0.0, $sub146 = 0, $sub181 = 0;
 var $sub203 = 0, $sub219 = 0.0, $sub256 = 0, $sub264 = 0, $sub281 = 0, $sub336 = 0, $sub343 = 0, $sub357 = 0, $sub409 = 0, $sub478 = 0, $sub480 = 0, $sub514 = 0, $sub562 = 0, $sub626 = 0, $sub735 = 0, $sub74 = 0, $sub806 = 0, $sub85 = 0.0, $sub86 = 0.0, $sub88 = 0.0;
 var $sub91 = 0.0, $sub97 = 0, $t$addr$0 = 0, $t$addr$1 = 0, $tobool129 = 0, $tobool13 = 0, $tobool135 = 0, $tobool139 = 0, $tobool140 = 0, $tobool222 = 0, $tobool244 = 0, $tobool252 = 0, $tobool290 = 0, $tobool290519 = 0, $tobool294 = 0, $tobool341 = 0, $tobool37 = 0, $tobool371 = 0, $tobool380 = 0, $tobool400 = 0;
 var $tobool454 = 0, $tobool484 = 0, $tobool490 = 0, $tobool56 = 0, $tobool609 = 0, $tobool609$not = 0, $tobool63 = 0, $tobool703 = 0, $tobool76 = 0, $tobool76421 = 0, $tobool781 = 0, $tobool79 = 0, $tobool9 = 0, $w$add653 = 0, $xor = 0, $xor167 = 0, $xor186 = 0, $xor655 = 0, $xor816 = 0, $y$addr$0 = 0.0;
 var $y$addr$1 = 0.0, $y$addr$2 = 0.0, $y$addr$3 = 0.0, $y$addr$4 = 0.0, $z$0 = 0, $z$1 = 0, $z$2$lcssa = 0, $z$2501 = 0, $z$3$lcssa = 0, $z$3497 = 0, $z$4$lcssa = 0, $z$4487 = 0, $z$5 = 0, $z$8 = 0, $z$9$lcssa = 0, $z$9459 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 560|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(560|0);
 $big = sp + 32|0;
 $e2 = sp + 536|0;
 $buf = sp;
 $sub$ptr$rhs$cast$le = $buf;
 $ebuf0 = sp + 540|0;
 HEAP32[$e2>>2] = 0;
 $arrayidx = ((($ebuf0)) + 12|0);
 $0 = (___DOUBLE_BITS_670($y)|0);
 $1 = (getTempRet0() | 0);
 $2 = ($1|0)<(0);
 if ($2) {
  $sub = - $y;
  $3 = (___DOUBLE_BITS_670($sub)|0);
  $4 = (getTempRet0() | 0);
  $8 = $4;$85 = $3;$pl$0 = 1;$prefix$0 = 1052;$y$addr$0 = $sub;
 } else {
  $and = $fl & 2048;
  $tobool9 = ($and|0)==(0);
  $and12 = $fl & 1;
  $tobool13 = ($and12|0)==(0);
  $$ = $tobool13 ? (1053) : (1058);
  $spec$select416 = $tobool9 ? $$ : (1055);
  $5 = $fl & 2049;
  $6 = ($5|0)!=(0);
  $spec$select417 = $6&1;
  $8 = $1;$85 = $0;$pl$0 = $spec$select417;$prefix$0 = $spec$select416;$y$addr$0 = $y;
 }
 $7 = $8 & 2146435072;
 $9 = (0)==(0);
 $10 = ($7|0)==(2146435072);
 $11 = $9 & $10;
 do {
  if ($11) {
   $and36 = $t & 32;
   $tobool37 = ($and36|0)!=(0);
   $cond = $tobool37 ? 1071 : 1075;
   $cmp38 = ($y$addr$0 != $y$addr$0) | (0.0 != 0.0);
   $cond43 = $tobool37 ? 1079 : 1083;
   $s35$0 = $cmp38 ? $cond43 : $cond;
   $add = (($pl$0) + 3)|0;
   $and45 = $fl & -65537;
   _pad_667($f,32,$w,$add,$and45);
   _out($f,$prefix$0,$pl$0);
   _out($f,$s35$0,3);
   $xor = $fl ^ 8192;
   _pad_667($f,32,$w,$add,$xor);
   $add653$sink524 = $add;
  } else {
   $call55 = (+_frexp($y$addr$0,$e2));
   $mul = $call55 * 2.0;
   $tobool56 = $mul != 0.0;
   if ($tobool56) {
    $12 = HEAP32[$e2>>2]|0;
    $dec = (($12) + -1)|0;
    HEAP32[$e2>>2] = $dec;
   }
   $or = $t | 32;
   $cmp59 = ($or|0)==(97);
   if ($cmp59) {
    $and62 = $t & 32;
    $tobool63 = ($and62|0)==(0);
    $add$ptr65 = ((($prefix$0)) + 9|0);
    $spec$select = $tobool63 ? $prefix$0 : $add$ptr65;
    $add67 = $pl$0 | 2;
    $13 = ($p>>>0)>(11);
    $sub74 = (12 - ($p))|0;
    $tobool76421 = ($sub74|0)==(0);
    $tobool76 = $13 | $tobool76421;
    do {
     if ($tobool76) {
      $y$addr$1 = $mul;
     } else {
      $re$1426 = $sub74;$round$0425 = 8.0;
      while(1) {
       $dec78 = (($re$1426) + -1)|0;
       $mul80 = $round$0425 * 16.0;
       $tobool79 = ($dec78|0)==(0);
       if ($tobool79) {
        break;
       } else {
        $re$1426 = $dec78;$round$0425 = $mul80;
       }
      }
      $14 = HEAP8[$spec$select>>0]|0;
      $cmp82 = ($14<<24>>24)==(45);
      if ($cmp82) {
       $sub85 = - $mul;
       $sub86 = $sub85 - $mul80;
       $add87 = $mul80 + $sub86;
       $sub88 = - $add87;
       $y$addr$1 = $sub88;
       break;
      } else {
       $add90 = $mul + $mul80;
       $sub91 = $add90 - $mul80;
       $y$addr$1 = $sub91;
       break;
      }
     }
    } while(0);
    $15 = HEAP32[$e2>>2]|0;
    $cmp94 = ($15|0)<(0);
    $sub97 = (0 - ($15))|0;
    $cond100 = $cmp94 ? $sub97 : $15;
    $16 = ($cond100|0)<(0);
    $17 = $16 << 31 >> 31;
    $18 = (_fmt_u($cond100,$17,$arrayidx)|0);
    $cmp103 = ($18|0)==($arrayidx|0);
    if ($cmp103) {
     $incdec$ptr106 = ((($ebuf0)) + 11|0);
     HEAP8[$incdec$ptr106>>0] = 48;
     $estr$0 = $incdec$ptr106;
    } else {
     $estr$0 = $18;
    }
    $19 = $15 >> 31;
    $20 = $19 & 2;
    $21 = (($20) + 43)|0;
    $conv111 = $21&255;
    $incdec$ptr112 = ((($estr$0)) + -1|0);
    HEAP8[$incdec$ptr112>>0] = $conv111;
    $add113 = (($t) + 15)|0;
    $conv114 = $add113&255;
    $incdec$ptr115 = ((($estr$0)) + -2|0);
    HEAP8[$incdec$ptr115>>0] = $conv114;
    $cmp131 = ($p|0)<(1);
    $and134 = $fl & 8;
    $tobool135 = ($and134|0)==(0);
    $s$0 = $buf;$y$addr$2 = $y$addr$1;
    while(1) {
     $conv116 = (~~(($y$addr$2)));
     $arrayidx117 = (480 + ($conv116)|0);
     $22 = HEAP8[$arrayidx117>>0]|0;
     $conv118393 = $22&255;
     $or120 = $and62 | $conv118393;
     $conv121 = $or120&255;
     $incdec$ptr122 = ((($s$0)) + 1|0);
     HEAP8[$s$0>>0] = $conv121;
     $conv123 = (+($conv116|0));
     $sub124 = $y$addr$2 - $conv123;
     $mul125 = $sub124 * 16.0;
     $sub$ptr$lhs$cast = $incdec$ptr122;
     $sub$ptr$sub = (($sub$ptr$lhs$cast) - ($sub$ptr$rhs$cast$le))|0;
     $cmp127 = ($sub$ptr$sub|0)==(1);
     if ($cmp127) {
      $tobool129 = $mul125 == 0.0;
      $or$cond1$not = $cmp131 & $tobool129;
      $or$cond = $tobool135 & $or$cond1$not;
      if ($or$cond) {
       $s$1 = $incdec$ptr122;
      } else {
       $incdec$ptr137 = ((($s$0)) + 2|0);
       HEAP8[$incdec$ptr122>>0] = 46;
       $s$1 = $incdec$ptr137;
      }
     } else {
      $s$1 = $incdec$ptr122;
     }
     $tobool139 = $mul125 != 0.0;
     if ($tobool139) {
      $s$0 = $s$1;$y$addr$2 = $mul125;
     } else {
      break;
     }
    }
    $tobool140 = ($p|0)==(0);
    $$pre517 = $s$1;
    if ($tobool140) {
     label = 25;
    } else {
     $sub$ptr$sub145 = (-2 - ($sub$ptr$rhs$cast$le))|0;
     $sub146 = (($sub$ptr$sub145) + ($$pre517))|0;
     $cmp147 = ($sub146|0)<($p|0);
     if ($cmp147) {
      $sub$ptr$lhs$cast151 = $arrayidx;
      $sub$ptr$rhs$cast152 = $incdec$ptr115;
      $sub$ptr$sub153 = (($p) + 2)|0;
      $add150 = (($sub$ptr$sub153) + ($sub$ptr$lhs$cast151))|0;
      $add154 = (($add150) - ($sub$ptr$rhs$cast152))|0;
      $l$0 = $add154;$sub$ptr$lhs$cast173$pre$phiZZZZ2D = $sub$ptr$lhs$cast151;$sub$ptr$rhs$cast174$pre$phiZZZZ2D = $sub$ptr$rhs$cast152;
     } else {
      label = 25;
     }
    }
    if ((label|0) == 25) {
     $sub$ptr$lhs$cast160 = $arrayidx;
     $sub$ptr$rhs$cast161 = $incdec$ptr115;
     $sub$ptr$sub159 = (($sub$ptr$lhs$cast160) - ($sub$ptr$rhs$cast$le))|0;
     $sub$ptr$sub162 = (($sub$ptr$sub159) - ($sub$ptr$rhs$cast161))|0;
     $add163 = (($sub$ptr$sub162) + ($$pre517))|0;
     $l$0 = $add163;$sub$ptr$lhs$cast173$pre$phiZZZZ2D = $sub$ptr$lhs$cast160;$sub$ptr$rhs$cast174$pre$phiZZZZ2D = $sub$ptr$rhs$cast161;
    }
    $add165 = (($l$0) + ($add67))|0;
    _pad_667($f,32,$w,$add165,$fl);
    _out($f,$spec$select,$add67);
    $xor167 = $fl ^ 65536;
    _pad_667($f,48,$w,$add165,$xor167);
    $sub$ptr$sub172 = (($$pre517) - ($sub$ptr$rhs$cast$le))|0;
    _out($f,$buf,$sub$ptr$sub172);
    $sub$ptr$sub175 = (($sub$ptr$lhs$cast173$pre$phiZZZZ2D) - ($sub$ptr$rhs$cast174$pre$phiZZZZ2D))|0;
    $23 = (($sub$ptr$sub172) + ($sub$ptr$sub175))|0;
    $sub181 = (($l$0) - ($23))|0;
    _pad_667($f,48,$sub181,0,0);
    _out($f,$incdec$ptr115,$sub$ptr$sub175);
    $xor186 = $fl ^ 8192;
    _pad_667($f,32,$w,$add165,$xor186);
    $add653$sink524 = $add165;
    break;
   }
   $cmp196 = ($p|0)<(0);
   $spec$select395 = $cmp196 ? 6 : $p;
   if ($tobool56) {
    $mul202 = $mul * 268435456.0;
    $24 = HEAP32[$e2>>2]|0;
    $sub203 = (($24) + -28)|0;
    HEAP32[$e2>>2] = $sub203;
    $$pr = $sub203;$y$addr$3 = $mul202;
   } else {
    $$pre = HEAP32[$e2>>2]|0;
    $$pr = $$pre;$y$addr$3 = $mul;
   }
   $cmp205 = ($$pr|0)<(0);
   $add$ptr213 = ((($big)) + 288|0);
   $z$0 = $cmp205 ? $big : $add$ptr213;
   $y$addr$4 = $y$addr$3;$z$1 = $z$0;
   while(1) {
    $conv216 = (~~(($y$addr$4))>>>0);
    HEAP32[$z$1>>2] = $conv216;
    $incdec$ptr217 = ((($z$1)) + 4|0);
    $conv218 = (+($conv216>>>0));
    $sub219 = $y$addr$4 - $conv218;
    $mul220 = $sub219 * 1.0E+9;
    $tobool222 = $mul220 != 0.0;
    if ($tobool222) {
     $y$addr$4 = $mul220;$z$1 = $incdec$ptr217;
    } else {
     break;
    }
   }
   $sub$ptr$rhs$cast345 = $z$0;
   $cmp225500 = ($$pr|0)>(0);
   if ($cmp225500) {
    $26 = $$pr;$a$1502 = $z$0;$z$2501 = $incdec$ptr217;
    while(1) {
     $25 = ($26|0)<(29);
     $cond233 = $25 ? $26 : 29;
     $d$0491 = ((($z$2501)) + -4|0);
     $cmp235492 = ($d$0491>>>0)<($a$1502>>>0);
     if ($cmp235492) {
      $a$2 = $a$1502;
     } else {
      $carry$0493 = 0;$d$0494 = $d$0491;
      while(1) {
       $27 = HEAP32[$d$0494>>2]|0;
       $28 = (_bitshift64Shl(($27|0),0,($cond233|0))|0);
       $29 = (getTempRet0() | 0);
       $30 = (_i64Add(($28|0),($29|0),($carry$0493|0),0)|0);
       $31 = (getTempRet0() | 0);
       $32 = (___udivdi3(($30|0),($31|0),1000000000,0)|0);
       $33 = (getTempRet0() | 0);
       $34 = (___muldi3(($32|0),($33|0),1000000000,0)|0);
       $35 = (getTempRet0() | 0);
       $36 = (_i64Subtract(($30|0),($31|0),($34|0),($35|0))|0);
       $37 = (getTempRet0() | 0);
       HEAP32[$d$0494>>2] = $36;
       $d$0 = ((($d$0494)) + -4|0);
       $cmp235 = ($d$0>>>0)<($a$1502>>>0);
       if ($cmp235) {
        break;
       } else {
        $carry$0493 = $32;$d$0494 = $d$0;
       }
      }
      $tobool244 = ($32|0)==(0);
      if ($tobool244) {
       $a$2 = $a$1502;
      } else {
       $incdec$ptr246 = ((($a$1502)) + -4|0);
       HEAP32[$incdec$ptr246>>2] = $32;
       $a$2 = $incdec$ptr246;
      }
     }
     $cmp249496 = ($z$2501>>>0)>($a$2>>>0);
     L57: do {
      if ($cmp249496) {
       $z$3497 = $z$2501;
       while(1) {
        $arrayidx251 = ((($z$3497)) + -4|0);
        $38 = HEAP32[$arrayidx251>>2]|0;
        $tobool252 = ($38|0)==(0);
        if (!($tobool252)) {
         $z$3$lcssa = $z$3497;
         break L57;
        }
        $cmp249 = ($arrayidx251>>>0)>($a$2>>>0);
        if ($cmp249) {
         $z$3497 = $arrayidx251;
        } else {
         $z$3$lcssa = $arrayidx251;
         break;
        }
       }
      } else {
       $z$3$lcssa = $z$2501;
      }
     } while(0);
     $39 = HEAP32[$e2>>2]|0;
     $sub256 = (($39) - ($cond233))|0;
     HEAP32[$e2>>2] = $sub256;
     $cmp225 = ($sub256|0)>(0);
     if ($cmp225) {
      $26 = $sub256;$a$1502 = $a$2;$z$2501 = $z$3$lcssa;
     } else {
      $$pr415 = $sub256;$a$1$lcssa = $a$2;$z$2$lcssa = $z$3$lcssa;
      break;
     }
    }
   } else {
    $$pr415 = $$pr;$a$1$lcssa = $z$0;$z$2$lcssa = $incdec$ptr217;
   }
   $cmp259486 = ($$pr415|0)<(0);
   if ($cmp259486) {
    $add273 = (($spec$select395) + 25)|0;
    $div274 = (($add273|0) / 9)&-1;
    $add275 = (($div274) + 1)|0;
    $cmp299 = ($or|0)==(102);
    $40 = $$pr415;$a$3488 = $a$1$lcssa;$z$4487 = $z$2$lcssa;
    while(1) {
     $sub264 = (0 - ($40))|0;
     $41 = ($sub264|0)<(9);
     $cond271 = $41 ? $sub264 : 9;
     $cmp277482 = ($a$3488>>>0)<($z$4487>>>0);
     if ($cmp277482) {
      $shl280 = 1 << $cond271;
      $sub281 = (($shl280) + -1)|0;
      $shr285 = 1000000000 >>> $cond271;
      $carry262$0484 = 0;$d$1483 = $a$3488;
      while(1) {
       $43 = HEAP32[$d$1483>>2]|0;
       $and282 = $43 & $sub281;
       $shr283 = $43 >>> $cond271;
       $add284 = (($shr283) + ($carry262$0484))|0;
       HEAP32[$d$1483>>2] = $add284;
       $mul286 = Math_imul($and282, $shr285)|0;
       $incdec$ptr288 = ((($d$1483)) + 4|0);
       $cmp277 = ($incdec$ptr288>>>0)<($z$4487>>>0);
       if ($cmp277) {
        $carry262$0484 = $mul286;$d$1483 = $incdec$ptr288;
       } else {
        break;
       }
      }
      $44 = HEAP32[$a$3488>>2]|0;
      $tobool290 = ($44|0)==(0);
      $incdec$ptr292 = ((($a$3488)) + 4|0);
      $spec$select396 = $tobool290 ? $incdec$ptr292 : $a$3488;
      $tobool294 = ($mul286|0)==(0);
      if ($tobool294) {
       $spec$select396523 = $spec$select396;$z$5 = $z$4487;
      } else {
       $incdec$ptr296 = ((($z$4487)) + 4|0);
       HEAP32[$z$4487>>2] = $mul286;
       $spec$select396523 = $spec$select396;$z$5 = $incdec$ptr296;
      }
     } else {
      $42 = HEAP32[$a$3488>>2]|0;
      $tobool290519 = ($42|0)==(0);
      $incdec$ptr292520 = ((($a$3488)) + 4|0);
      $spec$select396521 = $tobool290519 ? $incdec$ptr292520 : $a$3488;
      $spec$select396523 = $spec$select396521;$z$5 = $z$4487;
     }
     $cond304 = $cmp299 ? $z$0 : $spec$select396523;
     $sub$ptr$lhs$cast305 = $z$5;
     $sub$ptr$rhs$cast306 = $cond304;
     $sub$ptr$sub307 = (($sub$ptr$lhs$cast305) - ($sub$ptr$rhs$cast306))|0;
     $sub$ptr$div = $sub$ptr$sub307 >> 2;
     $cmp308 = ($sub$ptr$div|0)>($add275|0);
     $add$ptr311 = (($cond304) + ($add275<<2)|0);
     $spec$select397 = $cmp308 ? $add$ptr311 : $z$5;
     $45 = HEAP32[$e2>>2]|0;
     $add313 = (($45) + ($cond271))|0;
     HEAP32[$e2>>2] = $add313;
     $cmp259 = ($add313|0)<(0);
     if ($cmp259) {
      $40 = $add313;$a$3488 = $spec$select396523;$z$4487 = $spec$select397;
     } else {
      $a$3$lcssa = $spec$select396523;$z$4$lcssa = $spec$select397;
      break;
     }
    }
   } else {
    $a$3$lcssa = $a$1$lcssa;$z$4$lcssa = $z$2$lcssa;
   }
   $cmp315 = ($a$3$lcssa>>>0)<($z$4$lcssa>>>0);
   if ($cmp315) {
    $sub$ptr$rhs$cast319 = $a$3$lcssa;
    $sub$ptr$sub320 = (($sub$ptr$rhs$cast345) - ($sub$ptr$rhs$cast319))|0;
    $sub$ptr$div321 = $sub$ptr$sub320 >> 2;
    $mul322 = ($sub$ptr$div321*9)|0;
    $46 = HEAP32[$a$3$lcssa>>2]|0;
    $cmp324478 = ($46>>>0)<(10);
    if ($cmp324478) {
     $e$1 = $mul322;
    } else {
     $e$0480 = $mul322;$i$0479 = 10;
     while(1) {
      $mul328 = ($i$0479*10)|0;
      $inc = (($e$0480) + 1)|0;
      $cmp324 = ($46>>>0)<($mul328>>>0);
      if ($cmp324) {
       $e$1 = $inc;
       break;
      } else {
       $e$0480 = $inc;$i$0479 = $mul328;
      }
     }
    }
   } else {
    $e$1 = 0;
   }
   $cmp333 = ($or|0)==(102);
   $mul335 = $cmp333 ? 0 : $e$1;
   $sub336 = (($spec$select395) - ($mul335))|0;
   $cmp338 = ($or|0)==(103);
   $tobool341 = ($spec$select395|0)!=(0);
   $47 = $tobool341 & $cmp338;
   $land$ext$neg = $47 << 31 >> 31;
   $sub343 = (($sub336) + ($land$ext$neg))|0;
   $sub$ptr$lhs$cast344 = $z$4$lcssa;
   $sub$ptr$sub346 = (($sub$ptr$lhs$cast344) - ($sub$ptr$rhs$cast345))|0;
   $sub$ptr$div347 = $sub$ptr$sub346 >> 2;
   $48 = ($sub$ptr$div347*9)|0;
   $mul349 = (($48) + -9)|0;
   $cmp350 = ($sub343|0)<($mul349|0);
   if ($cmp350) {
    $add$ptr354 = ((($z$0)) + 4|0);
    $add355 = (($sub343) + 9216)|0;
    $div356 = (($add355|0) / 9)&-1;
    $sub357 = (($div356) + -1024)|0;
    $add$ptr358 = (($add$ptr354) + ($sub357<<2)|0);
    $49 = ($div356*9)|0;
    $50 = (($add355) - ($49))|0;
    $cmp363474 = ($50|0)<(8);
    if ($cmp363474) {
     $i$1475 = 10;$j$0$in476 = $50;
     while(1) {
      $j$0 = (($j$0$in476) + 1)|0;
      $mul367 = ($i$1475*10)|0;
      $cmp363 = ($j$0$in476|0)<(7);
      if ($cmp363) {
       $i$1475 = $mul367;$j$0$in476 = $j$0;
      } else {
       $i$1$lcssa = $mul367;
       break;
      }
     }
    } else {
     $i$1$lcssa = 10;
    }
    $51 = HEAP32[$add$ptr358>>2]|0;
    $div378 = (($51>>>0) / ($i$1$lcssa>>>0))&-1;
    $52 = Math_imul($div378, $i$1$lcssa)|0;
    $53 = (($51) - ($52))|0;
    $tobool371 = ($53|0)==(0);
    $add$ptr373 = ((($add$ptr358)) + 4|0);
    $cmp374 = ($add$ptr373|0)==($z$4$lcssa|0);
    $or$cond398 = $cmp374 & $tobool371;
    if ($or$cond398) {
     $a$8 = $a$3$lcssa;$d$4 = $add$ptr358;$e$4 = $e$1;
    } else {
     $and379 = $div378 & 1;
     $tobool380 = ($and379|0)==(0);
     $spec$select399 = $tobool380 ? 9007199254740992.0 : 9007199254740994.0;
     $div384 = $i$1$lcssa >>> 1;
     $cmp385 = ($53>>>0)<($div384>>>0);
     $cmp390 = ($53|0)==($div384|0);
     $or$cond400 = $cmp374 & $cmp390;
     $spec$select412 = $or$cond400 ? 1.0 : 1.5;
     $spec$select418 = $cmp385 ? 0.5 : $spec$select412;
     $tobool400 = ($pl$0|0)==(0);
     if ($tobool400) {
      $round377$1 = $spec$select399;$small$1 = $spec$select418;
     } else {
      $54 = HEAP8[$prefix$0>>0]|0;
      $cmp403 = ($54<<24>>24)==(45);
      $mul406 = - $spec$select399;
      $mul407 = - $spec$select418;
      $spec$select419 = $cmp403 ? $mul406 : $spec$select399;
      $spec$select420 = $cmp403 ? $mul407 : $spec$select418;
      $round377$1 = $spec$select419;$small$1 = $spec$select420;
     }
     $sub409 = (($51) - ($53))|0;
     HEAP32[$add$ptr358>>2] = $sub409;
     $add410 = $round377$1 + $small$1;
     $cmp411 = $add410 != $round377$1;
     if ($cmp411) {
      $add414 = (($sub409) + ($i$1$lcssa))|0;
      HEAP32[$add$ptr358>>2] = $add414;
      $cmp416469 = ($add414>>>0)>(999999999);
      if ($cmp416469) {
       $a$5471 = $a$3$lcssa;$d$2470 = $add$ptr358;
       while(1) {
        $incdec$ptr419 = ((($d$2470)) + -4|0);
        HEAP32[$d$2470>>2] = 0;
        $cmp420 = ($incdec$ptr419>>>0)<($a$5471>>>0);
        if ($cmp420) {
         $incdec$ptr423 = ((($a$5471)) + -4|0);
         HEAP32[$incdec$ptr423>>2] = 0;
         $a$6 = $incdec$ptr423;
        } else {
         $a$6 = $a$5471;
        }
        $55 = HEAP32[$incdec$ptr419>>2]|0;
        $inc425 = (($55) + 1)|0;
        HEAP32[$incdec$ptr419>>2] = $inc425;
        $cmp416 = ($inc425>>>0)>(999999999);
        if ($cmp416) {
         $a$5471 = $a$6;$d$2470 = $incdec$ptr419;
        } else {
         $a$5$lcssa = $a$6;$d$2$lcssa = $incdec$ptr419;
         break;
        }
       }
      } else {
       $a$5$lcssa = $a$3$lcssa;$d$2$lcssa = $add$ptr358;
      }
      $sub$ptr$rhs$cast428 = $a$5$lcssa;
      $sub$ptr$sub429 = (($sub$ptr$rhs$cast345) - ($sub$ptr$rhs$cast428))|0;
      $sub$ptr$div430 = $sub$ptr$sub429 >> 2;
      $mul431 = ($sub$ptr$div430*9)|0;
      $56 = HEAP32[$a$5$lcssa>>2]|0;
      $cmp433465 = ($56>>>0)<(10);
      if ($cmp433465) {
       $a$8 = $a$5$lcssa;$d$4 = $d$2$lcssa;$e$4 = $mul431;
      } else {
       $e$2467 = $mul431;$i$2466 = 10;
       while(1) {
        $mul437 = ($i$2466*10)|0;
        $inc438 = (($e$2467) + 1)|0;
        $cmp433 = ($56>>>0)<($mul437>>>0);
        if ($cmp433) {
         $a$8 = $a$5$lcssa;$d$4 = $d$2$lcssa;$e$4 = $inc438;
         break;
        } else {
         $e$2467 = $inc438;$i$2466 = $mul437;
        }
       }
      }
     } else {
      $a$8 = $a$3$lcssa;$d$4 = $add$ptr358;$e$4 = $e$1;
     }
    }
    $add$ptr442 = ((($d$4)) + 4|0);
    $cmp443 = ($z$4$lcssa>>>0)>($add$ptr442>>>0);
    $spec$select401 = $cmp443 ? $add$ptr442 : $z$4$lcssa;
    $a$9 = $a$8;$e$5 = $e$4;$z$8 = $spec$select401;
   } else {
    $a$9 = $a$3$lcssa;$e$5 = $e$1;$z$8 = $z$4$lcssa;
   }
   $sub626 = (0 - ($e$5))|0;
   $cmp450458 = ($z$8>>>0)>($a$9>>>0);
   L109: do {
    if ($cmp450458) {
     $z$9459 = $z$8;
     while(1) {
      $arrayidx453 = ((($z$9459)) + -4|0);
      $57 = HEAP32[$arrayidx453>>2]|0;
      $tobool454 = ($57|0)==(0);
      if (!($tobool454)) {
       $cmp450$lcssa = 1;$z$9$lcssa = $z$9459;
       break L109;
      }
      $cmp450 = ($arrayidx453>>>0)>($a$9>>>0);
      if ($cmp450) {
       $z$9459 = $arrayidx453;
      } else {
       $cmp450$lcssa = 0;$z$9$lcssa = $arrayidx453;
       break;
      }
     }
    } else {
     $cmp450$lcssa = 0;$z$9$lcssa = $z$8;
    }
   } while(0);
   do {
    if ($cmp338) {
     $not$tobool341 = $tobool341 ^ 1;
     $inc468 = $not$tobool341&1;
     $spec$select402 = (($spec$select395) + ($inc468))|0;
     $cmp470 = ($spec$select402|0)>($e$5|0);
     $cmp473 = ($e$5|0)>(-5);
     $or$cond2 = $cmp470 & $cmp473;
     if ($or$cond2) {
      $dec476 = (($t) + -1)|0;
      $add477$neg = (($spec$select402) + -1)|0;
      $sub478 = (($add477$neg) - ($e$5))|0;
      $p$addr$2 = $sub478;$t$addr$0 = $dec476;
     } else {
      $sub480 = (($t) + -2)|0;
      $dec481 = (($spec$select402) + -1)|0;
      $p$addr$2 = $dec481;$t$addr$0 = $sub480;
     }
     $and483 = $fl & 8;
     $tobool484 = ($and483|0)==(0);
     if ($tobool484) {
      if ($cmp450$lcssa) {
       $arrayidx489 = ((($z$9$lcssa)) + -4|0);
       $58 = HEAP32[$arrayidx489>>2]|0;
       $tobool490 = ($58|0)==(0);
       if ($tobool490) {
        $j$2 = 9;
       } else {
        $rem494453 = (($58>>>0) % 10)&-1;
        $cmp495454 = ($rem494453|0)==(0);
        if ($cmp495454) {
         $i$3455 = 10;$j$1456 = 0;
         while(1) {
          $mul499 = ($i$3455*10)|0;
          $inc500 = (($j$1456) + 1)|0;
          $rem494 = (($58>>>0) % ($mul499>>>0))&-1;
          $cmp495 = ($rem494|0)==(0);
          if ($cmp495) {
           $i$3455 = $mul499;$j$1456 = $inc500;
          } else {
           $j$2 = $inc500;
           break;
          }
         }
        } else {
         $j$2 = 0;
        }
       }
      } else {
       $j$2 = 9;
      }
      $or504 = $t$addr$0 | 32;
      $cmp505 = ($or504|0)==(102);
      $sub$ptr$lhs$cast508 = $z$9$lcssa;
      $sub$ptr$sub510 = (($sub$ptr$lhs$cast508) - ($sub$ptr$rhs$cast345))|0;
      $sub$ptr$div511 = $sub$ptr$sub510 >> 2;
      $59 = ($sub$ptr$div511*9)|0;
      $mul513 = (($59) + -9)|0;
      if ($cmp505) {
       $sub514 = (($mul513) - ($j$2))|0;
       $60 = ($sub514|0)>(0);
       $spec$select403 = $60 ? $sub514 : 0;
       $cmp528 = ($p$addr$2|0)<($spec$select403|0);
       $spec$select413 = $cmp528 ? $p$addr$2 : $spec$select403;
       $p$addr$3 = $spec$select413;$t$addr$1 = $t$addr$0;
       break;
      } else {
       $add561 = (($mul513) + ($e$5))|0;
       $sub562 = (($add561) - ($j$2))|0;
       $61 = ($sub562|0)>(0);
       $spec$select405 = $61 ? $sub562 : 0;
       $cmp577 = ($p$addr$2|0)<($spec$select405|0);
       $spec$select414 = $cmp577 ? $p$addr$2 : $spec$select405;
       $p$addr$3 = $spec$select414;$t$addr$1 = $t$addr$0;
       break;
      }
     } else {
      $p$addr$3 = $p$addr$2;$t$addr$1 = $t$addr$0;
     }
    } else {
     $p$addr$3 = $spec$select395;$t$addr$1 = $t;
    }
   } while(0);
   $tobool609 = ($p$addr$3|0)!=(0);
   $and610 = $fl >>> 3;
   $and610$lobit = $and610 & 1;
   $62 = $tobool609 ? 1 : $and610$lobit;
   $or613 = $t$addr$1 | 32;
   $cmp614 = ($or613|0)==(102);
   if ($cmp614) {
    $cmp617 = ($e$5|0)>(0);
    $add620 = $cmp617 ? $e$5 : 0;
    $estr$2 = 0;$sub$ptr$sub650$pn = $add620;
   } else {
    $cmp623 = ($e$5|0)<(0);
    $cond629 = $cmp623 ? $sub626 : $e$5;
    $63 = ($cond629|0)<(0);
    $64 = $63 << 31 >> 31;
    $65 = (_fmt_u($cond629,$64,$arrayidx)|0);
    $sub$ptr$lhs$cast633 = $arrayidx;
    $sub$ptr$rhs$cast634447 = $65;
    $sub$ptr$sub635448 = (($sub$ptr$lhs$cast633) - ($sub$ptr$rhs$cast634447))|0;
    $cmp636449 = ($sub$ptr$sub635448|0)<(2);
    if ($cmp636449) {
     $estr$1450 = $65;
     while(1) {
      $incdec$ptr639 = ((($estr$1450)) + -1|0);
      HEAP8[$incdec$ptr639>>0] = 48;
      $sub$ptr$rhs$cast634 = $incdec$ptr639;
      $sub$ptr$sub635 = (($sub$ptr$lhs$cast633) - ($sub$ptr$rhs$cast634))|0;
      $cmp636 = ($sub$ptr$sub635|0)<(2);
      if ($cmp636) {
       $estr$1450 = $incdec$ptr639;
      } else {
       $estr$1$lcssa = $incdec$ptr639;
       break;
      }
     }
    } else {
     $estr$1$lcssa = $65;
    }
    $66 = $e$5 >> 31;
    $67 = $66 & 2;
    $68 = (($67) + 43)|0;
    $conv644 = $68&255;
    $incdec$ptr645 = ((($estr$1$lcssa)) + -1|0);
    HEAP8[$incdec$ptr645>>0] = $conv644;
    $conv646 = $t$addr$1&255;
    $incdec$ptr647 = ((($estr$1$lcssa)) + -2|0);
    HEAP8[$incdec$ptr647>>0] = $conv646;
    $sub$ptr$rhs$cast649 = $incdec$ptr647;
    $sub$ptr$sub650 = (($sub$ptr$lhs$cast633) - ($sub$ptr$rhs$cast649))|0;
    $estr$2 = $incdec$ptr647;$sub$ptr$sub650$pn = $sub$ptr$sub650;
   }
   $add608 = (($pl$0) + 1)|0;
   $add612 = (($add608) + ($p$addr$3))|0;
   $l$1 = (($add612) + ($62))|0;
   $add653 = (($l$1) + ($sub$ptr$sub650$pn))|0;
   _pad_667($f,32,$w,$add653,$fl);
   _out($f,$prefix$0,$pl$0);
   $xor655 = $fl ^ 65536;
   _pad_667($f,48,$w,$add653,$xor655);
   if ($cmp614) {
    $cmp660 = ($a$9>>>0)>($z$0>>>0);
    $spec$select408 = $cmp660 ? $z$0 : $a$9;
    $add$ptr671 = ((($buf)) + 9|0);
    $sub$ptr$lhs$cast694 = $add$ptr671;
    $incdec$ptr689 = ((($buf)) + 8|0);
    $d$5438 = $spec$select408;
    while(1) {
     $69 = HEAP32[$d$5438>>2]|0;
     $70 = (_fmt_u($69,0,$add$ptr671)|0);
     $cmp673 = ($d$5438|0)==($spec$select408|0);
     if ($cmp673) {
      $cmp686 = ($70|0)==($add$ptr671|0);
      if ($cmp686) {
       HEAP8[$incdec$ptr689>>0] = 48;
       $s668$1 = $incdec$ptr689;
      } else {
       $s668$1 = $70;
      }
     } else {
      $cmp678435 = ($70>>>0)>($buf>>>0);
      if ($cmp678435) {
       $71 = $70;
       $72 = (($71) - ($sub$ptr$rhs$cast$le))|0;
       _memset(($buf|0),48,($72|0))|0;
       $s668$0436 = $70;
       while(1) {
        $incdec$ptr681 = ((($s668$0436)) + -1|0);
        $cmp678 = ($incdec$ptr681>>>0)>($buf>>>0);
        if ($cmp678) {
         $s668$0436 = $incdec$ptr681;
        } else {
         $s668$1 = $incdec$ptr681;
         break;
        }
       }
      } else {
       $s668$1 = $70;
      }
     }
     $sub$ptr$rhs$cast695 = $s668$1;
     $sub$ptr$sub696 = (($sub$ptr$lhs$cast694) - ($sub$ptr$rhs$cast695))|0;
     _out($f,$s668$1,$sub$ptr$sub696);
     $incdec$ptr698 = ((($d$5438)) + 4|0);
     $cmp665 = ($incdec$ptr698>>>0)>($z$0>>>0);
     if ($cmp665) {
      break;
     } else {
      $d$5438 = $incdec$ptr698;
     }
    }
    $tobool609$not = $tobool609 ^ 1;
    $and702 = $fl & 8;
    $tobool703 = ($and702|0)==(0);
    $or$cond409 = $tobool703 & $tobool609$not;
    if (!($or$cond409)) {
     _out($f,1087,1);
    }
    $cmp707430 = ($incdec$ptr698>>>0)<($z$9$lcssa>>>0);
    $cmp710431 = ($p$addr$3|0)>(0);
    $73 = $cmp707430 & $cmp710431;
    if ($73) {
     $d$6432 = $incdec$ptr698;$p$addr$4433 = $p$addr$3;
     while(1) {
      $74 = HEAP32[$d$6432>>2]|0;
      $75 = (_fmt_u($74,0,$add$ptr671)|0);
      $cmp722427 = ($75>>>0)>($buf>>>0);
      if ($cmp722427) {
       $76 = $75;
       $77 = (($76) - ($sub$ptr$rhs$cast$le))|0;
       _memset(($buf|0),48,($77|0))|0;
       $s715$0428 = $75;
       while(1) {
        $incdec$ptr725 = ((($s715$0428)) + -1|0);
        $cmp722 = ($incdec$ptr725>>>0)>($buf>>>0);
        if ($cmp722) {
         $s715$0428 = $incdec$ptr725;
        } else {
         $s715$0$lcssa = $incdec$ptr725;
         break;
        }
       }
      } else {
       $s715$0$lcssa = $75;
      }
      $78 = ($p$addr$4433|0)<(9);
      $cond732 = $78 ? $p$addr$4433 : 9;
      _out($f,$s715$0$lcssa,$cond732);
      $incdec$ptr734 = ((($d$6432)) + 4|0);
      $sub735 = (($p$addr$4433) + -9)|0;
      $cmp707 = ($incdec$ptr734>>>0)<($z$9$lcssa>>>0);
      $cmp710 = ($p$addr$4433|0)>(9);
      $79 = $cmp707 & $cmp710;
      if ($79) {
       $d$6432 = $incdec$ptr734;$p$addr$4433 = $sub735;
      } else {
       $p$addr$4$lcssa = $sub735;
       break;
      }
     }
    } else {
     $p$addr$4$lcssa = $p$addr$3;
    }
    $add737 = (($p$addr$4$lcssa) + 9)|0;
    _pad_667($f,48,$add737,9,0);
   } else {
    $add$ptr742 = ((($a$9)) + 4|0);
    $spec$select410 = $cmp450$lcssa ? $z$9$lcssa : $add$ptr742;
    $cmp745442 = ($a$9>>>0)<($spec$select410>>>0);
    $cmp748443 = ($p$addr$3|0)>(-1);
    $80 = $cmp745442 & $cmp748443;
    if ($80) {
     $add$ptr756 = ((($buf)) + 9|0);
     $and780 = $fl & 8;
     $tobool781 = ($and780|0)==(0);
     $sub$ptr$lhs$cast787 = $add$ptr756;
     $81 = (0 - ($sub$ptr$rhs$cast$le))|0;
     $incdec$ptr763 = ((($buf)) + 8|0);
     $d$7444 = $a$9;$p$addr$5445 = $p$addr$3;
     while(1) {
      $82 = HEAP32[$d$7444>>2]|0;
      $83 = (_fmt_u($82,0,$add$ptr756)|0);
      $cmp760 = ($83|0)==($add$ptr756|0);
      if ($cmp760) {
       HEAP8[$incdec$ptr763>>0] = 48;
       $s753$0 = $incdec$ptr763;
      } else {
       $s753$0 = $83;
      }
      $cmp765 = ($d$7444|0)==($a$9|0);
      do {
       if ($cmp765) {
        $incdec$ptr776 = ((($s753$0)) + 1|0);
        _out($f,$s753$0,1);
        $cmp777 = ($p$addr$5445|0)<(1);
        $or$cond411 = $tobool781 & $cmp777;
        if ($or$cond411) {
         $s753$2 = $incdec$ptr776;
         break;
        }
        _out($f,1087,1);
        $s753$2 = $incdec$ptr776;
       } else {
        $cmp770439 = ($s753$0>>>0)>($buf>>>0);
        if (!($cmp770439)) {
         $s753$2 = $s753$0;
         break;
        }
        $scevgep513 = (($s753$0) + ($81)|0);
        $scevgep513514 = $scevgep513;
        _memset(($buf|0),48,($scevgep513514|0))|0;
        $s753$1440 = $s753$0;
        while(1) {
         $incdec$ptr773 = ((($s753$1440)) + -1|0);
         $cmp770 = ($incdec$ptr773>>>0)>($buf>>>0);
         if ($cmp770) {
          $s753$1440 = $incdec$ptr773;
         } else {
          $s753$2 = $incdec$ptr773;
          break;
         }
        }
       }
      } while(0);
      $sub$ptr$rhs$cast788 = $s753$2;
      $sub$ptr$sub789 = (($sub$ptr$lhs$cast787) - ($sub$ptr$rhs$cast788))|0;
      $cmp790 = ($p$addr$5445|0)>($sub$ptr$sub789|0);
      $cond800 = $cmp790 ? $sub$ptr$sub789 : $p$addr$5445;
      _out($f,$s753$2,$cond800);
      $sub806 = (($p$addr$5445) - ($sub$ptr$sub789))|0;
      $incdec$ptr808 = ((($d$7444)) + 4|0);
      $cmp745 = ($incdec$ptr808>>>0)<($spec$select410>>>0);
      $cmp748 = ($sub806|0)>(-1);
      $84 = $cmp745 & $cmp748;
      if ($84) {
       $d$7444 = $incdec$ptr808;$p$addr$5445 = $sub806;
      } else {
       $p$addr$5$lcssa = $sub806;
       break;
      }
     }
    } else {
     $p$addr$5$lcssa = $p$addr$3;
    }
    $add810 = (($p$addr$5$lcssa) + 18)|0;
    _pad_667($f,48,$add810,18,0);
    $sub$ptr$lhs$cast811 = $arrayidx;
    $sub$ptr$rhs$cast812 = $estr$2;
    $sub$ptr$sub813 = (($sub$ptr$lhs$cast811) - ($sub$ptr$rhs$cast812))|0;
    _out($f,$estr$2,$sub$ptr$sub813);
   }
   $xor816 = $fl ^ 8192;
   _pad_667($f,32,$w,$add653,$xor816);
   $add653$sink524 = $add653;
  }
 } while(0);
 $cmp818 = ($add653$sink524|0)<($w|0);
 $w$add653 = $cmp818 ? $w : $add653$sink524;
 STACKTOP = sp;return ($w$add653|0);
}
function _pop_arg_long_double($arg,$ap) {
 $arg = $arg|0;
 $ap = $ap|0;
 var $0 = 0, $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0.0, $arglist_current = 0, $arglist_next = 0, $expanded = 0, $expanded1 = 0, $expanded3 = 0, $expanded4 = 0, $expanded5 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $arglist_current = HEAP32[$ap>>2]|0;
 $0 = $arglist_current;
 $1 = ((0) + 8|0);
 $expanded1 = $1;
 $expanded = (($expanded1) - 1)|0;
 $2 = (($0) + ($expanded))|0;
 $3 = ((0) + 8|0);
 $expanded5 = $3;
 $expanded4 = (($expanded5) - 1)|0;
 $expanded3 = $expanded4 ^ -1;
 $4 = $2 & $expanded3;
 $5 = $4;
 $6 = +HEAPF64[$5>>3];
 $arglist_next = ((($5)) + 8|0);
 HEAP32[$ap>>2] = $arglist_next;
 HEAPF64[$arg>>3] = $6;
 return;
}
function ___vfprintf_internal($f,$fmt,$ap,$fmt_fp,$pop_arg_long_double) {
 $f = $f|0;
 $fmt = $fmt|0;
 $ap = $ap|0;
 $fmt_fp = $fmt_fp|0;
 $pop_arg_long_double = $pop_arg_long_double|0;
 var $0 = 0, $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $add$ptr = 0, $and = 0, $and11 = 0, $and36 = 0, $ap2 = 0, $buf = 0, $buf_size = 0, $call = 0, $call21 = 0, $call2133 = 0, $call6 = 0, $cmp = 0;
 var $cmp5 = 0, $cmp7 = 0, $cond = 0, $internal_buf = 0, $lock = 0, $mode = 0, $nl_arg = 0, $nl_type = 0, $or = 0, $ret$1 = 0, $retval$0 = 0, $spec$select = 0, $spec$select32 = 0, $tobool = 0, $tobool22 = 0, $tobool26 = 0, $tobool37 = 0, $tobool41 = 0, $vacopy_currentptr = 0, $wbase = 0;
 var $wend = 0, $wpos = 0, $write = 0, dest = 0, label = 0, sp = 0, stop = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 224|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(224|0);
 $ap2 = sp + 208|0;
 $nl_type = sp + 160|0;
 $nl_arg = sp + 80|0;
 $internal_buf = sp;
 dest=$nl_type; stop=dest+40|0; do { HEAP32[dest>>2]=0|0; dest=dest+4|0; } while ((dest|0) < (stop|0));
 $vacopy_currentptr = HEAP32[$ap>>2]|0;
 HEAP32[$ap2>>2] = $vacopy_currentptr;
 $call = (_printf_core(0,$fmt,$ap2,$nl_arg,$nl_type,$fmt_fp,$pop_arg_long_double)|0);
 $cmp = ($call|0)<(0);
 if ($cmp) {
  $retval$0 = -1;
 } else {
  $lock = ((($f)) + 76|0);
  $0 = HEAP32[$lock>>2]|0;
  $cmp5 = ($0|0)>(-1);
  if ($cmp5) {
   $call6 = (___lockfile($f)|0);
   $cond = $call6;
  } else {
   $cond = 0;
  }
  $1 = HEAP32[$f>>2]|0;
  $and = $1 & 32;
  $mode = ((($f)) + 74|0);
  $2 = HEAP8[$mode>>0]|0;
  $cmp7 = ($2<<24>>24)<(1);
  if ($cmp7) {
   $and11 = $1 & -33;
   HEAP32[$f>>2] = $and11;
  }
  $buf_size = ((($f)) + 48|0);
  $3 = HEAP32[$buf_size>>2]|0;
  $tobool = ($3|0)==(0);
  if ($tobool) {
   $buf = ((($f)) + 44|0);
   $4 = HEAP32[$buf>>2]|0;
   HEAP32[$buf>>2] = $internal_buf;
   $wbase = ((($f)) + 28|0);
   HEAP32[$wbase>>2] = $internal_buf;
   $wpos = ((($f)) + 20|0);
   HEAP32[$wpos>>2] = $internal_buf;
   HEAP32[$buf_size>>2] = 80;
   $add$ptr = ((($internal_buf)) + 80|0);
   $wend = ((($f)) + 16|0);
   HEAP32[$wend>>2] = $add$ptr;
   $call21 = (_printf_core($f,$fmt,$ap2,$nl_arg,$nl_type,$fmt_fp,$pop_arg_long_double)|0);
   $tobool22 = ($4|0)==(0|0);
   if ($tobool22) {
    $ret$1 = $call21;
   } else {
    $write = ((($f)) + 36|0);
    $5 = HEAP32[$write>>2]|0;
    (FUNCTION_TABLE_iiii[$5 & 7]($f,0,0)|0);
    $6 = HEAP32[$wpos>>2]|0;
    $tobool26 = ($6|0)==(0|0);
    $spec$select = $tobool26 ? -1 : $call21;
    HEAP32[$buf>>2] = $4;
    HEAP32[$buf_size>>2] = 0;
    HEAP32[$wend>>2] = 0;
    HEAP32[$wbase>>2] = 0;
    HEAP32[$wpos>>2] = 0;
    $ret$1 = $spec$select;
   }
  } else {
   $call2133 = (_printf_core($f,$fmt,$ap2,$nl_arg,$nl_type,$fmt_fp,$pop_arg_long_double)|0);
   $ret$1 = $call2133;
  }
  $7 = HEAP32[$f>>2]|0;
  $and36 = $7 & 32;
  $tobool37 = ($and36|0)==(0);
  $spec$select32 = $tobool37 ? $ret$1 : -1;
  $or = $7 | $and;
  HEAP32[$f>>2] = $or;
  $tobool41 = ($cond|0)==(0);
  if (!($tobool41)) {
   ___unlockfile($f);
  }
  $retval$0 = $spec$select32;
 }
 STACKTOP = sp;return ($retval$0|0);
}
function _printf_core($f,$fmt,$ap,$nl_arg,$nl_type,$fmt_fp,$pop_arg_long_double) {
 $f = $f|0;
 $fmt = $fmt|0;
 $ap = $ap|0;
 $nl_arg = $nl_arg|0;
 $nl_type = $nl_type|0;
 $fmt_fp = $fmt_fp|0;
 $pop_arg_long_double = $pop_arg_long_double|0;
 var $$ = 0, $$lcssa213 = 0, $$pre = 0, $$pre261 = 0, $$pre262 = 0, $$pre263 = 0, $$pre263$pre = 0, $$pre264 = 0, $$pre267 = 0, $$sink = 0, $0 = 0, $1 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0;
 var $107 = 0, $108 = 0, $109 = 0, $11 = 0, $110 = 0, $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0, $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $124 = 0;
 var $125 = 0, $126 = 0, $127 = 0, $128 = 0, $129 = 0, $13 = 0, $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0, $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0;
 var $143 = 0, $144 = 0, $145 = 0, $146 = 0, $147 = 0, $148 = 0, $149 = 0, $15 = 0, $150 = 0, $151 = 0, $152 = 0, $153 = 0, $154 = 0, $155 = 0, $156 = 0, $157 = 0, $158 = 0, $159 = 0, $16 = 0, $160 = 0;
 var $161 = 0, $162 = 0, $163 = 0, $164 = 0, $165 = 0.0, $166 = 0, $167 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0;
 var $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0;
 var $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0;
 var $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0;
 var $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, $a$0 = 0, $a$1 = 0;
 var $add = 0, $add$ptr = 0, $add$ptr139 = 0, $add$ptr150 = 0, $add$ptr206 = 0, $add$ptr258 = 0, $add$ptr341 = 0, $add$ptr354 = 0, $add$ptr468 = 0, $add$ptr88 = 0, $add270 = 0, $add323 = 0, $add390 = 0, $add407 = 0, $add436 = 0, $and = 0, $and211 = 0, $and215 = 0, $and217 = 0, $and220 = 0;
 var $and233 = 0, $and250 = 0, $and255 = 0, $and264 = 0, $and290 = 0, $and295 = 0, $and310 = 0, $arg = 0, $arglist_current = 0, $arglist_current2 = 0, $arglist_next = 0, $arglist_next3 = 0, $argpos$0 = 0, $arrayidx114 = 0, $arrayidx119 = 0, $arrayidx124 = 0, $arrayidx129 = 0, $arrayidx132 = 0, $arrayidx16 = 0, $arrayidx174 = 0;
 var $arrayidx193 = 0, $arrayidx207 = 0, $arrayidx31 = 0, $arrayidx35 = 0, $arrayidx365 = 0, $arrayidx40 = 0, $arrayidx464 = 0, $arrayidx476 = 0, $arrayidx68 = 0, $arrayidx73 = 0, $arrayidx78 = 0, $arrayidx81 = 0, $brmerge = 0, $brmerge235 = 0, $buf = 0, $call = 0, $call104 = 0, $call121 = 0, $call160 = 0, $call33 = 0;
 var $call351 = 0, $call379 = 0, $call406 = 0, $call424 = 0, $call70 = 0, $cmp = 0, $cmp1 = 0, $cmp105 = 0, $cmp111 = 0, $cmp116 = 0, $cmp126 = 0, $cmp13 = 0, $cmp166 = 0, $cmp177 = 0, $cmp18 = 0, $cmp182 = 0, $cmp185 = 0, $cmp212 = 0, $cmp241 = 0, $cmp271 = 0;
 var $cmp307 = 0, $cmp324 = 0, $cmp37 = 0, $cmp372 = 0, $cmp372242 = 0, $cmp380 = 0, $cmp385 = 0, $cmp399 = 0, $cmp399247 = 0, $cmp408 = 0, $cmp416 = 0, $cmp429 = 0, $cmp437 = 0, $cmp461 = 0, $cmp473 = 0, $cmp50 = 0, $cmp50231 = 0, $cmp65 = 0, $cmp75 = 0, $cmp97 = 0;
 var $cnt$0 = 0, $cnt$0$ph = 0, $cnt$1 = 0, $cond = 0, $cond149 = 0, $cond246 = 0, $cond350 = 0, $cond421 = 0, $conv120 = 0, $conv130 = 0, $conv134 = 0, $conv164 = 0, $conv172 = 0, $conv175 = 0, $conv208 = 0, $conv230 = 0, $conv233 = 0, $conv32 = 0, $conv41 = 0, $conv48 = 0;
 var $conv48229 = 0, $conv69 = 0, $conv79 = 0, $conv83 = 0, $expanded = 0, $expanded10 = 0, $expanded11 = 0, $expanded13 = 0, $expanded14 = 0, $expanded15 = 0, $expanded4 = 0, $expanded6 = 0, $expanded7 = 0, $expanded8 = 0, $fl$0$lcssa = 0, $fl$0237 = 0, $fl$1 = 0, $fl$3 = 0, $fl$4 = 0, $fl$6 = 0;
 var $i$0217 = 0, $i$0217271 = 0, $i$0243 = 0, $i$1248 = 0, $i$2224 = 0, $i$3221 = 0, $i137 = 0, $i86 = 0, $inc = 0, $inc483 = 0, $incdec$ptr = 0, $incdec$ptr171 = 0, $incdec$ptr23 = 0, $incdec$ptr378 = 0, $incdec$ptr405 = 0, $incdec$ptr45 = 0, $incdec$ptr62 = 0, $incdec$ptr93 = 0, $l$0 = 0, $l$0$ph = 0;
 var $l$0$ph$be = 0, $l10n$0$ph = 0, $l10n$1 = 0, $l10n$2 = 0, $l10n$3 = 0, $lnot = 0, $lnot$ext = 0, $mb = 0, $or = 0, $or$cond = 0, $or$cond189 = 0, $or$cond190 = 0, $or$cond194 = 0, $or100 = 0, $or247 = 0, $p$0 = 0, $p$1 = 0, $p$2 = 0, $p$2$add323 = 0, $p$3 = 0;
 var $p$4269 = 0, $p$5 = 0, $pl$0 = 0, $pl$1 = 0, $pl$2 = 0, $prefix$0 = 0, $prefix$1 = 0, $prefix$2 = 0, $retval$0 = 0, $s = 0, $shl = 0, $shl232 = 0, $shl60 = 0, $shr199 = 0, $spec$select = 0, $spec$select193 = 0, $spec$select195 = 0, $spec$select200 = 0, $spec$select201 = 0, $spec$select202 = 0;
 var $spec$select203 = 0, $spec$select204 = 0, $spec$select205 = 0, $spec$select206 = 0, $spec$select207 = 0, $spec$select208 = 0, $st$0 = 0, $storemerge187$lcssa = 0, $storemerge187236 = 0, $storemerge188 = 0, $sub = 0, $sub$ptr$lhs$cast = 0, $sub$ptr$lhs$cast318 = 0, $sub$ptr$lhs$cast356 = 0, $sub$ptr$lhs$cast426$pre$phiZZZZ2D = 0, $sub$ptr$rhs$cast = 0, $sub$ptr$rhs$cast268 = 0, $sub$ptr$rhs$cast319 = 0, $sub$ptr$rhs$cast357 = 0, $sub$ptr$rhs$cast427 = 0;
 var $sub$ptr$sub = 0, $sub$ptr$sub269 = 0, $sub$ptr$sub320 = 0, $sub$ptr$sub358 = 0, $sub$ptr$sub428 = 0, $sub101 = 0, $sub131 = 0, $sub135 = 0, $sub165 = 0, $sub173 = 0, $sub176 = 0, $sub384 = 0, $sub42 = 0, $sub49 = 0, $sub49230 = 0, $sub49238 = 0, $sub80 = 0, $sub84 = 0, $t$0 = 0, $t$1 = 0;
 var $tobool = 0, $tobool122 = 0, $tobool141 = 0, $tobool179 = 0, $tobool209 = 0, $tobool218 = 0, $tobool25 = 0, $tobool256 = 0, $tobool265 = 0, $tobool28 = 0, $tobool291 = 0, $tobool296 = 0, $tobool315 = 0, $tobool34 = 0, $tobool345 = 0, $tobool352 = 0, $tobool375 = 0, $tobool402 = 0, $tobool454 = 0, $tobool457 = 0;
 var $tobool465 = 0, $tobool477 = 0, $tobool55 = 0, $tobool55234 = 0, $tobool71 = 0, $tobool90 = 0, $trunc = 0, $w$0 = 0, $w$1 = 0, $w$2 = 0, $wc = 0, $ws$0244 = 0, $ws$1249 = 0, $xor = 0, $xor444 = 0, $xor452 = 0, $z$0$lcssa = 0, $z$0226 = 0, $z$1 = 0, label = 0;
 var sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 64|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(64|0);
 $s = sp + 56|0;
 $arg = sp + 40|0;
 $buf = sp;
 $wc = sp + 48|0;
 $mb = sp + 60|0;
 HEAP32[$s>>2] = $fmt;
 $tobool25 = ($f|0)!=(0|0);
 $add$ptr206 = ((($buf)) + 40|0);
 $sub$ptr$lhs$cast318 = $add$ptr206;
 $add$ptr341 = ((($buf)) + 39|0);
 $arrayidx365 = ((($wc)) + 4|0);
 $cnt$0$ph = 0;$l$0$ph = 0;$l10n$0$ph = 0;
 L1: while(1) {
  $cnt$0 = $cnt$0$ph;$l$0 = $l$0$ph;
  while(1) {
   $cmp = ($cnt$0|0)>(-1);
   do {
    if ($cmp) {
     $sub = (2147483647 - ($cnt$0))|0;
     $cmp1 = ($l$0|0)>($sub|0);
     if ($cmp1) {
      $call = (___errno_location()|0);
      HEAP32[$call>>2] = 75;
      $cnt$1 = -1;
      break;
     } else {
      $add = (($l$0) + ($cnt$0))|0;
      $cnt$1 = $add;
      break;
     }
    } else {
     $cnt$1 = $cnt$0;
    }
   } while(0);
   $0 = HEAP32[$s>>2]|0;
   $1 = HEAP8[$0>>0]|0;
   $tobool = ($1<<24>>24)==(0);
   if ($tobool) {
    label = 92;
    break L1;
   }
   $2 = $1;$3 = $0;
   L12: while(1) {
    switch ($2<<24>>24) {
    case 37:  {
     label = 10;
     break L12;
     break;
    }
    case 0:  {
     $z$0$lcssa = $3;
     break L12;
     break;
    }
    default: {
    }
    }
    $incdec$ptr = ((($3)) + 1|0);
    HEAP32[$s>>2] = $incdec$ptr;
    $$pre = HEAP8[$incdec$ptr>>0]|0;
    $2 = $$pre;$3 = $incdec$ptr;
   }
   L15: do {
    if ((label|0) == 10) {
     label = 0;
     $4 = $3;$z$0226 = $3;
     while(1) {
      $arrayidx16 = ((($4)) + 1|0);
      $5 = HEAP8[$arrayidx16>>0]|0;
      $cmp18 = ($5<<24>>24)==(37);
      if (!($cmp18)) {
       $z$0$lcssa = $z$0226;
       break L15;
      }
      $incdec$ptr23 = ((($z$0226)) + 1|0);
      $add$ptr = ((($4)) + 2|0);
      HEAP32[$s>>2] = $add$ptr;
      $6 = HEAP8[$add$ptr>>0]|0;
      $cmp13 = ($6<<24>>24)==(37);
      if ($cmp13) {
       $4 = $add$ptr;$z$0226 = $incdec$ptr23;
      } else {
       $z$0$lcssa = $incdec$ptr23;
       break;
      }
     }
    }
   } while(0);
   $sub$ptr$lhs$cast = $z$0$lcssa;
   $sub$ptr$rhs$cast = $0;
   $sub$ptr$sub = (($sub$ptr$lhs$cast) - ($sub$ptr$rhs$cast))|0;
   if ($tobool25) {
    _out($f,$0,$sub$ptr$sub);
   }
   $tobool28 = ($sub$ptr$sub|0)==(0);
   if ($tobool28) {
    break;
   } else {
    $cnt$0 = $cnt$1;$l$0 = $sub$ptr$sub;
   }
  }
  $7 = HEAP32[$s>>2]|0;
  $arrayidx31 = ((($7)) + 1|0);
  $8 = HEAP8[$arrayidx31>>0]|0;
  $conv32 = $8 << 24 >> 24;
  $call33 = (_isdigit($conv32)|0);
  $tobool34 = ($call33|0)==(0);
  $$pre261 = HEAP32[$s>>2]|0;
  if ($tobool34) {
   $$sink = 1;$argpos$0 = -1;$l10n$1 = $l10n$0$ph;
  } else {
   $arrayidx35 = ((($$pre261)) + 2|0);
   $9 = HEAP8[$arrayidx35>>0]|0;
   $cmp37 = ($9<<24>>24)==(36);
   if ($cmp37) {
    $arrayidx40 = ((($$pre261)) + 1|0);
    $10 = HEAP8[$arrayidx40>>0]|0;
    $conv41 = $10 << 24 >> 24;
    $sub42 = (($conv41) + -48)|0;
    $$sink = 3;$argpos$0 = $sub42;$l10n$1 = 1;
   } else {
    $$sink = 1;$argpos$0 = -1;$l10n$1 = $l10n$0$ph;
   }
  }
  $incdec$ptr45 = (($$pre261) + ($$sink)|0);
  HEAP32[$s>>2] = $incdec$ptr45;
  $11 = HEAP8[$incdec$ptr45>>0]|0;
  $conv48229 = $11 << 24 >> 24;
  $sub49230 = (($conv48229) + -32)|0;
  $cmp50231 = ($sub49230>>>0)>(31);
  $shl232 = 1 << $sub49230;
  $and233 = $shl232 & 75913;
  $tobool55234 = ($and233|0)==(0);
  $brmerge235 = $cmp50231 | $tobool55234;
  if ($brmerge235) {
   $$lcssa213 = $11;$fl$0$lcssa = 0;$storemerge187$lcssa = $incdec$ptr45;
  } else {
   $fl$0237 = 0;$storemerge187236 = $incdec$ptr45;$sub49238 = $sub49230;
   while(1) {
    $shl60 = 1 << $sub49238;
    $or = $shl60 | $fl$0237;
    $incdec$ptr62 = ((($storemerge187236)) + 1|0);
    HEAP32[$s>>2] = $incdec$ptr62;
    $12 = HEAP8[$incdec$ptr62>>0]|0;
    $conv48 = $12 << 24 >> 24;
    $sub49 = (($conv48) + -32)|0;
    $cmp50 = ($sub49>>>0)>(31);
    $shl = 1 << $sub49;
    $and = $shl & 75913;
    $tobool55 = ($and|0)==(0);
    $brmerge = $cmp50 | $tobool55;
    if ($brmerge) {
     $$lcssa213 = $12;$fl$0$lcssa = $or;$storemerge187$lcssa = $incdec$ptr62;
     break;
    } else {
     $fl$0237 = $or;$storemerge187236 = $incdec$ptr62;$sub49238 = $sub49;
    }
   }
  }
  $cmp65 = ($$lcssa213<<24>>24)==(42);
  if ($cmp65) {
   $arrayidx68 = ((($storemerge187$lcssa)) + 1|0);
   $13 = HEAP8[$arrayidx68>>0]|0;
   $conv69 = $13 << 24 >> 24;
   $call70 = (_isdigit($conv69)|0);
   $tobool71 = ($call70|0)==(0);
   if ($tobool71) {
    label = 27;
   } else {
    $14 = HEAP32[$s>>2]|0;
    $arrayidx73 = ((($14)) + 2|0);
    $15 = HEAP8[$arrayidx73>>0]|0;
    $cmp75 = ($15<<24>>24)==(36);
    if ($cmp75) {
     $arrayidx78 = ((($14)) + 1|0);
     $16 = HEAP8[$arrayidx78>>0]|0;
     $conv79 = $16 << 24 >> 24;
     $sub80 = (($conv79) + -48)|0;
     $arrayidx81 = (($nl_type) + ($sub80<<2)|0);
     HEAP32[$arrayidx81>>2] = 10;
     $17 = HEAP8[$arrayidx78>>0]|0;
     $conv83 = $17 << 24 >> 24;
     $sub84 = (($conv83) + -48)|0;
     $i86 = (($nl_arg) + ($sub84<<3)|0);
     $18 = $i86;
     $19 = $18;
     $20 = HEAP32[$19>>2]|0;
     $21 = (($18) + 4)|0;
     $22 = $21;
     $23 = HEAP32[$22>>2]|0;
     $add$ptr88 = ((($14)) + 3|0);
     $l10n$2 = 1;$storemerge188 = $add$ptr88;$w$0 = $20;
    } else {
     label = 27;
    }
   }
   if ((label|0) == 27) {
    label = 0;
    $tobool90 = ($l10n$1|0)==(0);
    if (!($tobool90)) {
     $retval$0 = -1;
     break;
    }
    if ($tobool25) {
     $arglist_current = HEAP32[$ap>>2]|0;
     $24 = $arglist_current;
     $25 = ((0) + 4|0);
     $expanded4 = $25;
     $expanded = (($expanded4) - 1)|0;
     $26 = (($24) + ($expanded))|0;
     $27 = ((0) + 4|0);
     $expanded8 = $27;
     $expanded7 = (($expanded8) - 1)|0;
     $expanded6 = $expanded7 ^ -1;
     $28 = $26 & $expanded6;
     $29 = $28;
     $30 = HEAP32[$29>>2]|0;
     $arglist_next = ((($29)) + 4|0);
     HEAP32[$ap>>2] = $arglist_next;
     $cond = $30;
    } else {
     $cond = 0;
    }
    $31 = HEAP32[$s>>2]|0;
    $incdec$ptr93 = ((($31)) + 1|0);
    $l10n$2 = 0;$storemerge188 = $incdec$ptr93;$w$0 = $cond;
   }
   HEAP32[$s>>2] = $storemerge188;
   $cmp97 = ($w$0|0)<(0);
   $or100 = $fl$0$lcssa | 8192;
   $sub101 = (0 - ($w$0))|0;
   $spec$select200 = $cmp97 ? $or100 : $fl$0$lcssa;
   $spec$select201 = $cmp97 ? $sub101 : $w$0;
   $33 = $storemerge188;$fl$1 = $spec$select200;$l10n$3 = $l10n$2;$w$1 = $spec$select201;
  } else {
   $call104 = (_getint($s)|0);
   $cmp105 = ($call104|0)<(0);
   if ($cmp105) {
    $retval$0 = -1;
    break;
   }
   $$pre262 = HEAP32[$s>>2]|0;
   $33 = $$pre262;$fl$1 = $fl$0$lcssa;$l10n$3 = $l10n$1;$w$1 = $call104;
  }
  $32 = HEAP8[$33>>0]|0;
  $cmp111 = ($32<<24>>24)==(46);
  do {
   if ($cmp111) {
    $arrayidx114 = ((($33)) + 1|0);
    $34 = HEAP8[$arrayidx114>>0]|0;
    $cmp116 = ($34<<24>>24)==(42);
    if (!($cmp116)) {
     HEAP32[$s>>2] = $arrayidx114;
     $call160 = (_getint($s)|0);
     $$pre263$pre = HEAP32[$s>>2]|0;
     $$pre263 = $$pre263$pre;$p$0 = $call160;
     break;
    }
    $arrayidx119 = ((($33)) + 2|0);
    $35 = HEAP8[$arrayidx119>>0]|0;
    $conv120 = $35 << 24 >> 24;
    $call121 = (_isdigit($conv120)|0);
    $tobool122 = ($call121|0)==(0);
    if (!($tobool122)) {
     $36 = HEAP32[$s>>2]|0;
     $arrayidx124 = ((($36)) + 3|0);
     $37 = HEAP8[$arrayidx124>>0]|0;
     $cmp126 = ($37<<24>>24)==(36);
     if ($cmp126) {
      $arrayidx129 = ((($36)) + 2|0);
      $38 = HEAP8[$arrayidx129>>0]|0;
      $conv130 = $38 << 24 >> 24;
      $sub131 = (($conv130) + -48)|0;
      $arrayidx132 = (($nl_type) + ($sub131<<2)|0);
      HEAP32[$arrayidx132>>2] = 10;
      $39 = HEAP8[$arrayidx129>>0]|0;
      $conv134 = $39 << 24 >> 24;
      $sub135 = (($conv134) + -48)|0;
      $i137 = (($nl_arg) + ($sub135<<3)|0);
      $40 = $i137;
      $41 = $40;
      $42 = HEAP32[$41>>2]|0;
      $43 = (($40) + 4)|0;
      $44 = $43;
      $45 = HEAP32[$44>>2]|0;
      $add$ptr139 = ((($36)) + 4|0);
      HEAP32[$s>>2] = $add$ptr139;
      $$pre263 = $add$ptr139;$p$0 = $42;
      break;
     }
    }
    $tobool141 = ($l10n$3|0)==(0);
    if (!($tobool141)) {
     $retval$0 = -1;
     break L1;
    }
    if ($tobool25) {
     $arglist_current2 = HEAP32[$ap>>2]|0;
     $46 = $arglist_current2;
     $47 = ((0) + 4|0);
     $expanded11 = $47;
     $expanded10 = (($expanded11) - 1)|0;
     $48 = (($46) + ($expanded10))|0;
     $49 = ((0) + 4|0);
     $expanded15 = $49;
     $expanded14 = (($expanded15) - 1)|0;
     $expanded13 = $expanded14 ^ -1;
     $50 = $48 & $expanded13;
     $51 = $50;
     $52 = HEAP32[$51>>2]|0;
     $arglist_next3 = ((($51)) + 4|0);
     HEAP32[$ap>>2] = $arglist_next3;
     $cond149 = $52;
    } else {
     $cond149 = 0;
    }
    $53 = HEAP32[$s>>2]|0;
    $add$ptr150 = ((($53)) + 2|0);
    HEAP32[$s>>2] = $add$ptr150;
    $$pre263 = $add$ptr150;$p$0 = $cond149;
   } else {
    $$pre263 = $33;$p$0 = -1;
   }
  } while(0);
  $55 = $$pre263;$st$0 = 0;
  while(1) {
   $54 = HEAP8[$55>>0]|0;
   $conv164 = $54 << 24 >> 24;
   $sub165 = (($conv164) + -65)|0;
   $cmp166 = ($sub165>>>0)>(57);
   if ($cmp166) {
    $retval$0 = -1;
    break L1;
   }
   $incdec$ptr171 = ((($55)) + 1|0);
   HEAP32[$s>>2] = $incdec$ptr171;
   $56 = HEAP8[$55>>0]|0;
   $conv172 = $56 << 24 >> 24;
   $sub173 = (($conv172) + -65)|0;
   $arrayidx174 = ((16 + (($st$0*58)|0)|0) + ($sub173)|0);
   $57 = HEAP8[$arrayidx174>>0]|0;
   $conv175 = $57&255;
   $sub176 = (($conv175) + -1)|0;
   $cmp177 = ($sub176>>>0)<(8);
   if ($cmp177) {
    $55 = $incdec$ptr171;$st$0 = $conv175;
   } else {
    break;
   }
  }
  $tobool179 = ($57<<24>>24)==(0);
  if ($tobool179) {
   $retval$0 = -1;
   break;
  }
  $cmp182 = ($57<<24>>24)==(19);
  $cmp185 = ($argpos$0|0)>(-1);
  do {
   if ($cmp182) {
    if ($cmp185) {
     $retval$0 = -1;
     break L1;
    } else {
     label = 54;
    }
   } else {
    if ($cmp185) {
     $arrayidx193 = (($nl_type) + ($argpos$0<<2)|0);
     HEAP32[$arrayidx193>>2] = $conv175;
     $58 = (($nl_arg) + ($argpos$0<<3)|0);
     $59 = $58;
     $60 = $59;
     $61 = HEAP32[$60>>2]|0;
     $62 = (($59) + 4)|0;
     $63 = $62;
     $64 = HEAP32[$63>>2]|0;
     $65 = $arg;
     $66 = $65;
     HEAP32[$66>>2] = $61;
     $67 = (($65) + 4)|0;
     $68 = $67;
     HEAP32[$68>>2] = $64;
     label = 54;
     break;
    }
    if (!($tobool25)) {
     $retval$0 = 0;
     break L1;
    }
    _pop_arg($arg,$conv175,$ap,$pop_arg_long_double);
    $$pre264 = HEAP32[$s>>2]|0;
    $69 = $$pre264;
    label = 55;
   }
  } while(0);
  if ((label|0) == 54) {
   label = 0;
   if ($tobool25) {
    $69 = $incdec$ptr171;
    label = 55;
   } else {
    $l$0$ph$be = 0;
   }
  }
  L77: do {
   if ((label|0) == 55) {
    label = 0;
    $arrayidx207 = ((($69)) + -1|0);
    $70 = HEAP8[$arrayidx207>>0]|0;
    $conv208 = $70 << 24 >> 24;
    $tobool209 = ($st$0|0)!=(0);
    $and211 = $conv208 & 15;
    $cmp212 = ($and211|0)==(3);
    $or$cond189 = $tobool209 & $cmp212;
    $and215 = $conv208 & -33;
    $t$0 = $or$cond189 ? $and215 : $conv208;
    $and217 = $fl$1 & 8192;
    $tobool218 = ($and217|0)==(0);
    $and220 = $fl$1 & -65537;
    $spec$select = $tobool218 ? $fl$1 : $and220;
    L79: do {
     switch ($t$0|0) {
     case 110:  {
      $trunc = $st$0&255;
      switch ($trunc<<24>>24) {
      case 0:  {
       $77 = HEAP32[$arg>>2]|0;
       HEAP32[$77>>2] = $cnt$1;
       $l$0$ph$be = 0;
       break L77;
       break;
      }
      case 1:  {
       $78 = HEAP32[$arg>>2]|0;
       HEAP32[$78>>2] = $cnt$1;
       $l$0$ph$be = 0;
       break L77;
       break;
      }
      case 2:  {
       $79 = ($cnt$1|0)<(0);
       $80 = $79 << 31 >> 31;
       $81 = HEAP32[$arg>>2]|0;
       $82 = $81;
       $83 = $82;
       HEAP32[$83>>2] = $cnt$1;
       $84 = (($82) + 4)|0;
       $85 = $84;
       HEAP32[$85>>2] = $80;
       $l$0$ph$be = 0;
       break L77;
       break;
      }
      case 3:  {
       $conv230 = $cnt$1&65535;
       $86 = HEAP32[$arg>>2]|0;
       HEAP16[$86>>1] = $conv230;
       $l$0$ph$be = 0;
       break L77;
       break;
      }
      case 4:  {
       $conv233 = $cnt$1&255;
       $87 = HEAP32[$arg>>2]|0;
       HEAP8[$87>>0] = $conv233;
       $l$0$ph$be = 0;
       break L77;
       break;
      }
      case 6:  {
       $88 = HEAP32[$arg>>2]|0;
       HEAP32[$88>>2] = $cnt$1;
       $l$0$ph$be = 0;
       break L77;
       break;
      }
      case 7:  {
       $89 = ($cnt$1|0)<(0);
       $90 = $89 << 31 >> 31;
       $91 = HEAP32[$arg>>2]|0;
       $92 = $91;
       $93 = $92;
       HEAP32[$93>>2] = $cnt$1;
       $94 = (($92) + 4)|0;
       $95 = $94;
       HEAP32[$95>>2] = $90;
       $l$0$ph$be = 0;
       break L77;
       break;
      }
      default: {
       $l$0$ph$be = 0;
       break L77;
      }
      }
      break;
     }
     case 112:  {
      $cmp241 = ($p$0>>>0)>(8);
      $cond246 = $cmp241 ? $p$0 : 8;
      $or247 = $spec$select | 8;
      $fl$3 = $or247;$p$1 = $cond246;$t$1 = 120;
      label = 67;
      break;
     }
     case 88: case 120:  {
      $fl$3 = $spec$select;$p$1 = $p$0;$t$1 = $t$0;
      label = 67;
      break;
     }
     case 111:  {
      $112 = $arg;
      $113 = $112;
      $114 = HEAP32[$113>>2]|0;
      $115 = (($112) + 4)|0;
      $116 = $115;
      $117 = HEAP32[$116>>2]|0;
      $118 = (_fmt_o($114,$117,$add$ptr206)|0);
      $and264 = $spec$select & 8;
      $tobool265 = ($and264|0)==(0);
      $sub$ptr$rhs$cast268 = $118;
      $sub$ptr$sub269 = (($sub$ptr$lhs$cast318) - ($sub$ptr$rhs$cast268))|0;
      $cmp271 = ($p$0|0)>($sub$ptr$sub269|0);
      $add270 = (($sub$ptr$sub269) + 1)|0;
      $119 = $tobool265 | $cmp271;
      $spec$select204 = $119 ? $p$0 : $add270;
      $a$0 = $118;$fl$4 = $spec$select;$p$2 = $spec$select204;$pl$1 = 0;$prefix$1 = 1035;
      label = 73;
      break;
     }
     case 105: case 100:  {
      $120 = $arg;
      $121 = $120;
      $122 = HEAP32[$121>>2]|0;
      $123 = (($120) + 4)|0;
      $124 = $123;
      $125 = HEAP32[$124>>2]|0;
      $126 = ($125|0)<(0);
      if ($126) {
       $127 = (_i64Subtract(0,0,($122|0),($125|0))|0);
       $128 = (getTempRet0() | 0);
       $129 = $arg;
       $130 = $129;
       HEAP32[$130>>2] = $127;
       $131 = (($129) + 4)|0;
       $132 = $131;
       HEAP32[$132>>2] = $128;
       $135 = $127;$136 = $128;$pl$0 = 1;$prefix$0 = 1035;
       label = 72;
       break L79;
      } else {
       $and290 = $spec$select & 2048;
       $tobool291 = ($and290|0)==(0);
       $and295 = $spec$select & 1;
       $tobool296 = ($and295|0)==(0);
       $$ = $tobool296 ? 1035 : (1037);
       $spec$select205 = $tobool291 ? $$ : (1036);
       $133 = $spec$select & 2049;
       $134 = ($133|0)!=(0);
       $spec$select206 = $134&1;
       $135 = $122;$136 = $125;$pl$0 = $spec$select206;$prefix$0 = $spec$select205;
       label = 72;
       break L79;
      }
      break;
     }
     case 117:  {
      $71 = $arg;
      $72 = $71;
      $73 = HEAP32[$72>>2]|0;
      $74 = (($71) + 4)|0;
      $75 = $74;
      $76 = HEAP32[$75>>2]|0;
      $135 = $73;$136 = $76;$pl$0 = 0;$prefix$0 = 1035;
      label = 72;
      break;
     }
     case 99:  {
      $147 = $arg;
      $148 = $147;
      $149 = HEAP32[$148>>2]|0;
      $150 = (($147) + 4)|0;
      $151 = $150;
      $152 = HEAP32[$151>>2]|0;
      $153 = $149&255;
      HEAP8[$add$ptr341>>0] = $153;
      $a$1 = $add$ptr341;$fl$6 = $and220;$p$5 = 1;$pl$2 = 0;$prefix$2 = 1035;$sub$ptr$lhs$cast426$pre$phiZZZZ2D = $sub$ptr$lhs$cast318;
      break;
     }
     case 115:  {
      $154 = HEAP32[$arg>>2]|0;
      $tobool345 = ($154|0)==(0|0);
      $cond350 = $tobool345 ? 1045 : $154;
      $call351 = (_memchr($cond350,0,$p$0)|0);
      $tobool352 = ($call351|0)==(0|0);
      $sub$ptr$lhs$cast356 = $call351;
      $sub$ptr$rhs$cast357 = $cond350;
      $sub$ptr$sub358 = (($sub$ptr$lhs$cast356) - ($sub$ptr$rhs$cast357))|0;
      $add$ptr354 = (($cond350) + ($p$0)|0);
      $p$3 = $tobool352 ? $p$0 : $sub$ptr$sub358;
      $z$1 = $tobool352 ? $add$ptr354 : $call351;
      $$pre267 = $z$1;
      $a$1 = $cond350;$fl$6 = $and220;$p$5 = $p$3;$pl$2 = 0;$prefix$2 = 1035;$sub$ptr$lhs$cast426$pre$phiZZZZ2D = $$pre267;
      break;
     }
     case 67:  {
      $155 = $arg;
      $156 = $155;
      $157 = HEAP32[$156>>2]|0;
      $158 = (($155) + 4)|0;
      $159 = $158;
      $160 = HEAP32[$159>>2]|0;
      HEAP32[$wc>>2] = $157;
      HEAP32[$arrayidx365>>2] = 0;
      HEAP32[$arg>>2] = $wc;
      $p$4269 = -1;
      label = 79;
      break;
     }
     case 83:  {
      $cmp372242 = ($p$0|0)==(0);
      if ($cmp372242) {
       _pad_667($f,32,$w$1,0,$spec$select);
       $i$0217271 = 0;
       label = 89;
      } else {
       $p$4269 = $p$0;
       label = 79;
      }
      break;
     }
     case 65: case 71: case 70: case 69: case 97: case 103: case 102: case 101:  {
      $165 = +HEAPF64[$arg>>3];
      $call424 = (FUNCTION_TABLE_iidiiii[$fmt_fp & 7]($f,$165,$w$1,$p$0,$spec$select,$t$0)|0);
      $l$0$ph$be = $call424;
      break L77;
      break;
     }
     default: {
      $a$1 = $0;$fl$6 = $spec$select;$p$5 = $p$0;$pl$2 = 0;$prefix$2 = 1035;$sub$ptr$lhs$cast426$pre$phiZZZZ2D = $sub$ptr$lhs$cast318;
     }
     }
    } while(0);
    L102: do {
     if ((label|0) == 67) {
      label = 0;
      $96 = $arg;
      $97 = $96;
      $98 = HEAP32[$97>>2]|0;
      $99 = (($96) + 4)|0;
      $100 = $99;
      $101 = HEAP32[$100>>2]|0;
      $and250 = $t$1 & 32;
      $102 = (_fmt_x($98,$101,$add$ptr206,$and250)|0);
      $103 = $arg;
      $104 = $103;
      $105 = HEAP32[$104>>2]|0;
      $106 = (($103) + 4)|0;
      $107 = $106;
      $108 = HEAP32[$107>>2]|0;
      $109 = ($105|0)==(0);
      $110 = ($108|0)==(0);
      $111 = $109 & $110;
      $and255 = $fl$3 & 8;
      $tobool256 = ($and255|0)==(0);
      $or$cond190 = $tobool256 | $111;
      $shr199 = $t$1 >>> 4;
      $add$ptr258 = (1035 + ($shr199)|0);
      $spec$select202 = $or$cond190 ? 1035 : $add$ptr258;
      $spec$select203 = $or$cond190 ? 0 : 2;
      $a$0 = $102;$fl$4 = $fl$3;$p$2 = $p$1;$pl$1 = $spec$select203;$prefix$1 = $spec$select202;
      label = 73;
     }
     else if ((label|0) == 72) {
      label = 0;
      $137 = (_fmt_u($135,$136,$add$ptr206)|0);
      $a$0 = $137;$fl$4 = $spec$select;$p$2 = $p$0;$pl$1 = $pl$0;$prefix$1 = $prefix$0;
      label = 73;
     }
     else if ((label|0) == 79) {
      label = 0;
      $161 = HEAP32[$arg>>2]|0;
      $i$0243 = 0;$ws$0244 = $161;
      while(1) {
       $162 = HEAP32[$ws$0244>>2]|0;
       $tobool375 = ($162|0)==(0);
       if ($tobool375) {
        $i$0217 = $i$0243;
        break;
       }
       $call379 = (_wctomb($mb,$162)|0);
       $cmp380 = ($call379|0)<(0);
       $sub384 = (($p$4269) - ($i$0243))|0;
       $cmp385 = ($call379>>>0)>($sub384>>>0);
       $or$cond194 = $cmp380 | $cmp385;
       if ($or$cond194) {
        label = 83;
        break;
       }
       $incdec$ptr378 = ((($ws$0244)) + 4|0);
       $add390 = (($call379) + ($i$0243))|0;
       $cmp372 = ($p$4269>>>0)>($add390>>>0);
       if ($cmp372) {
        $i$0243 = $add390;$ws$0244 = $incdec$ptr378;
       } else {
        $i$0217 = $add390;
        break;
       }
      }
      if ((label|0) == 83) {
       label = 0;
       if ($cmp380) {
        $retval$0 = -1;
        break L1;
       } else {
        $i$0217 = $i$0243;
       }
      }
      _pad_667($f,32,$w$1,$i$0217,$spec$select);
      $cmp399247 = ($i$0217|0)==(0);
      if ($cmp399247) {
       $i$0217271 = 0;
       label = 89;
      } else {
       $163 = HEAP32[$arg>>2]|0;
       $i$1248 = 0;$ws$1249 = $163;
       while(1) {
        $164 = HEAP32[$ws$1249>>2]|0;
        $tobool402 = ($164|0)==(0);
        if ($tobool402) {
         $i$0217271 = $i$0217;
         label = 89;
         break L102;
        }
        $call406 = (_wctomb($mb,$164)|0);
        $add407 = (($call406) + ($i$1248))|0;
        $cmp408 = ($add407|0)>($i$0217|0);
        if ($cmp408) {
         $i$0217271 = $i$0217;
         label = 89;
         break L102;
        }
        $incdec$ptr405 = ((($ws$1249)) + 4|0);
        _out($f,$mb,$call406);
        $cmp399 = ($add407>>>0)<($i$0217>>>0);
        if ($cmp399) {
         $i$1248 = $add407;$ws$1249 = $incdec$ptr405;
        } else {
         $i$0217271 = $i$0217;
         label = 89;
         break;
        }
       }
      }
     }
    } while(0);
    if ((label|0) == 73) {
     label = 0;
     $cmp307 = ($p$2|0)>(-1);
     $and310 = $fl$4 & -65537;
     $spec$select193 = $cmp307 ? $and310 : $fl$4;
     $138 = $arg;
     $139 = $138;
     $140 = HEAP32[$139>>2]|0;
     $141 = (($138) + 4)|0;
     $142 = $141;
     $143 = HEAP32[$142>>2]|0;
     $144 = ($140|0)!=(0);
     $145 = ($143|0)!=(0);
     $146 = $144 | $145;
     $tobool315 = ($p$2|0)!=(0);
     $or$cond = $tobool315 | $146;
     $sub$ptr$rhs$cast319 = $a$0;
     $sub$ptr$sub320 = (($sub$ptr$lhs$cast318) - ($sub$ptr$rhs$cast319))|0;
     $lnot = $146 ^ 1;
     $lnot$ext = $lnot&1;
     $add323 = (($sub$ptr$sub320) + ($lnot$ext))|0;
     $cmp324 = ($p$2|0)>($add323|0);
     $p$2$add323 = $cmp324 ? $p$2 : $add323;
     $spec$select207 = $or$cond ? $p$2$add323 : 0;
     $spec$select208 = $or$cond ? $a$0 : $add$ptr206;
     $a$1 = $spec$select208;$fl$6 = $spec$select193;$p$5 = $spec$select207;$pl$2 = $pl$1;$prefix$2 = $prefix$1;$sub$ptr$lhs$cast426$pre$phiZZZZ2D = $sub$ptr$lhs$cast318;
    }
    else if ((label|0) == 89) {
     label = 0;
     $xor = $spec$select ^ 8192;
     _pad_667($f,32,$w$1,$i$0217271,$xor);
     $cmp416 = ($w$1|0)>($i$0217271|0);
     $cond421 = $cmp416 ? $w$1 : $i$0217271;
     $l$0$ph$be = $cond421;
     break;
    }
    $sub$ptr$rhs$cast427 = $a$1;
    $sub$ptr$sub428 = (($sub$ptr$lhs$cast426$pre$phiZZZZ2D) - ($sub$ptr$rhs$cast427))|0;
    $cmp429 = ($p$5|0)<($sub$ptr$sub428|0);
    $spec$select195 = $cmp429 ? $sub$ptr$sub428 : $p$5;
    $add436 = (($spec$select195) + ($pl$2))|0;
    $cmp437 = ($w$1|0)<($add436|0);
    $w$2 = $cmp437 ? $add436 : $w$1;
    _pad_667($f,32,$w$2,$add436,$fl$6);
    _out($f,$prefix$2,$pl$2);
    $xor444 = $fl$6 ^ 65536;
    _pad_667($f,48,$w$2,$add436,$xor444);
    _pad_667($f,48,$spec$select195,$sub$ptr$sub428,0);
    _out($f,$a$1,$sub$ptr$sub428);
    $xor452 = $fl$6 ^ 8192;
    _pad_667($f,32,$w$2,$add436,$xor452);
    $l$0$ph$be = $w$2;
   }
  } while(0);
  $cnt$0$ph = $cnt$1;$l$0$ph = $l$0$ph$be;$l10n$0$ph = $l10n$3;
 }
 L123: do {
  if ((label|0) == 92) {
   $tobool454 = ($f|0)==(0|0);
   if ($tobool454) {
    $tobool457 = ($l10n$0$ph|0)==(0);
    if ($tobool457) {
     $retval$0 = 0;
    } else {
     $i$2224 = 1;
     while(1) {
      $arrayidx464 = (($nl_type) + ($i$2224<<2)|0);
      $166 = HEAP32[$arrayidx464>>2]|0;
      $tobool465 = ($166|0)==(0);
      if ($tobool465) {
       break;
      }
      $add$ptr468 = (($nl_arg) + ($i$2224<<3)|0);
      _pop_arg($add$ptr468,$166,$ap,$pop_arg_long_double);
      $inc = (($i$2224) + 1)|0;
      $cmp461 = ($inc>>>0)<(10);
      if ($cmp461) {
       $i$2224 = $inc;
      } else {
       $retval$0 = 1;
       break L123;
      }
     }
     $i$3221 = $i$2224;
     while(1) {
      $arrayidx476 = (($nl_type) + ($i$3221<<2)|0);
      $167 = HEAP32[$arrayidx476>>2]|0;
      $tobool477 = ($167|0)==(0);
      $inc483 = (($i$3221) + 1)|0;
      if (!($tobool477)) {
       $retval$0 = -1;
       break L123;
      }
      $cmp473 = ($inc483>>>0)<(10);
      if ($cmp473) {
       $i$3221 = $inc483;
      } else {
       $retval$0 = 1;
       break;
      }
     }
    }
   } else {
    $retval$0 = $cnt$1;
   }
  }
 } while(0);
 STACKTOP = sp;return ($retval$0|0);
}
function ___lockfile($f) {
 $f = $f|0;
 var label = 0, sp = 0;
 sp = STACKTOP;
 return 1;
}
function ___unlockfile($f) {
 $f = $f|0;
 var label = 0, sp = 0;
 sp = STACKTOP;
 return;
}
function _out($f,$s,$l) {
 $f = $f|0;
 $s = $s|0;
 $l = $l|0;
 var $0 = 0, $and = 0, $tobool = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $0 = HEAP32[$f>>2]|0;
 $and = $0 & 32;
 $tobool = ($and|0)==(0);
 if ($tobool) {
  (___fwritex($s,$l,$f)|0);
 }
 return;
}
function _getint($s) {
 $s = $s|0;
 var $0 = 0, $1 = 0, $2 = 0, $3 = 0, $4 = 0, $add = 0, $call = 0, $call5 = 0, $conv = 0, $conv1 = 0, $conv4 = 0, $i$0$lcssa = 0, $i$07 = 0, $incdec$ptr = 0, $mul = 0, $sub = 0, $tobool = 0, $tobool6 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $0 = HEAP32[$s>>2]|0;
 $1 = HEAP8[$0>>0]|0;
 $conv4 = $1 << 24 >> 24;
 $call5 = (_isdigit($conv4)|0);
 $tobool6 = ($call5|0)==(0);
 if ($tobool6) {
  $i$0$lcssa = 0;
 } else {
  $i$07 = 0;
  while(1) {
   $mul = ($i$07*10)|0;
   $2 = HEAP32[$s>>2]|0;
   $3 = HEAP8[$2>>0]|0;
   $conv1 = $3 << 24 >> 24;
   $sub = (($mul) + -48)|0;
   $add = (($sub) + ($conv1))|0;
   $incdec$ptr = ((($2)) + 1|0);
   HEAP32[$s>>2] = $incdec$ptr;
   $4 = HEAP8[$incdec$ptr>>0]|0;
   $conv = $4 << 24 >> 24;
   $call = (_isdigit($conv)|0);
   $tobool = ($call|0)==(0);
   if ($tobool) {
    $i$0$lcssa = $add;
    break;
   } else {
    $i$07 = $add;
   }
  }
 }
 return ($i$0$lcssa|0);
}
function _pop_arg($arg,$type,$ap,$pop_arg_long_double) {
 $arg = $arg|0;
 $type = $type|0;
 $ap = $ap|0;
 $pop_arg_long_double = $pop_arg_long_double|0;
 var $0 = 0, $1 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0.0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0;
 var $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0;
 var $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0;
 var $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0;
 var $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0;
 var $96 = 0, $97 = 0, $98 = 0, $99 = 0, $arglist_current = 0, $arglist_current11 = 0, $arglist_current14 = 0, $arglist_current17 = 0, $arglist_current2 = 0, $arglist_current20 = 0, $arglist_current23 = 0, $arglist_current5 = 0, $arglist_current8 = 0, $arglist_next = 0, $arglist_next12 = 0, $arglist_next15 = 0, $arglist_next18 = 0, $arglist_next21 = 0, $arglist_next24 = 0, $arglist_next3 = 0;
 var $arglist_next6 = 0, $arglist_next9 = 0, $cmp = 0, $conv16 = 0, $conv22$mask = 0, $conv28 = 0, $conv34$mask = 0, $expanded = 0, $expanded25 = 0, $expanded27 = 0, $expanded28 = 0, $expanded29 = 0, $expanded31 = 0, $expanded32 = 0, $expanded34 = 0, $expanded35 = 0, $expanded36 = 0, $expanded38 = 0, $expanded39 = 0, $expanded41 = 0;
 var $expanded42 = 0, $expanded43 = 0, $expanded45 = 0, $expanded46 = 0, $expanded48 = 0, $expanded49 = 0, $expanded50 = 0, $expanded52 = 0, $expanded53 = 0, $expanded55 = 0, $expanded56 = 0, $expanded57 = 0, $expanded59 = 0, $expanded60 = 0, $expanded62 = 0, $expanded63 = 0, $expanded64 = 0, $expanded66 = 0, $expanded67 = 0, $expanded69 = 0;
 var $expanded70 = 0, $expanded71 = 0, $expanded73 = 0, $expanded74 = 0, $expanded76 = 0, $expanded77 = 0, $expanded78 = 0, $expanded80 = 0, $expanded81 = 0, $expanded83 = 0, $expanded84 = 0, $expanded85 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $cmp = ($type>>>0)>(20);
 L1: do {
  if (!($cmp)) {
   do {
    switch ($type|0) {
    case 9:  {
     $arglist_current = HEAP32[$ap>>2]|0;
     $0 = $arglist_current;
     $1 = ((0) + 4|0);
     $expanded25 = $1;
     $expanded = (($expanded25) - 1)|0;
     $2 = (($0) + ($expanded))|0;
     $3 = ((0) + 4|0);
     $expanded29 = $3;
     $expanded28 = (($expanded29) - 1)|0;
     $expanded27 = $expanded28 ^ -1;
     $4 = $2 & $expanded27;
     $5 = $4;
     $6 = HEAP32[$5>>2]|0;
     $arglist_next = ((($5)) + 4|0);
     HEAP32[$ap>>2] = $arglist_next;
     HEAP32[$arg>>2] = $6;
     break L1;
     break;
    }
    case 10:  {
     $arglist_current2 = HEAP32[$ap>>2]|0;
     $7 = $arglist_current2;
     $8 = ((0) + 4|0);
     $expanded32 = $8;
     $expanded31 = (($expanded32) - 1)|0;
     $9 = (($7) + ($expanded31))|0;
     $10 = ((0) + 4|0);
     $expanded36 = $10;
     $expanded35 = (($expanded36) - 1)|0;
     $expanded34 = $expanded35 ^ -1;
     $11 = $9 & $expanded34;
     $12 = $11;
     $13 = HEAP32[$12>>2]|0;
     $arglist_next3 = ((($12)) + 4|0);
     HEAP32[$ap>>2] = $arglist_next3;
     $14 = ($13|0)<(0);
     $15 = $14 << 31 >> 31;
     $16 = $arg;
     $17 = $16;
     HEAP32[$17>>2] = $13;
     $18 = (($16) + 4)|0;
     $19 = $18;
     HEAP32[$19>>2] = $15;
     break L1;
     break;
    }
    case 11:  {
     $arglist_current5 = HEAP32[$ap>>2]|0;
     $20 = $arglist_current5;
     $21 = ((0) + 4|0);
     $expanded39 = $21;
     $expanded38 = (($expanded39) - 1)|0;
     $22 = (($20) + ($expanded38))|0;
     $23 = ((0) + 4|0);
     $expanded43 = $23;
     $expanded42 = (($expanded43) - 1)|0;
     $expanded41 = $expanded42 ^ -1;
     $24 = $22 & $expanded41;
     $25 = $24;
     $26 = HEAP32[$25>>2]|0;
     $arglist_next6 = ((($25)) + 4|0);
     HEAP32[$ap>>2] = $arglist_next6;
     $27 = $arg;
     $28 = $27;
     HEAP32[$28>>2] = $26;
     $29 = (($27) + 4)|0;
     $30 = $29;
     HEAP32[$30>>2] = 0;
     break L1;
     break;
    }
    case 12:  {
     $arglist_current8 = HEAP32[$ap>>2]|0;
     $31 = $arglist_current8;
     $32 = ((0) + 8|0);
     $expanded46 = $32;
     $expanded45 = (($expanded46) - 1)|0;
     $33 = (($31) + ($expanded45))|0;
     $34 = ((0) + 8|0);
     $expanded50 = $34;
     $expanded49 = (($expanded50) - 1)|0;
     $expanded48 = $expanded49 ^ -1;
     $35 = $33 & $expanded48;
     $36 = $35;
     $37 = $36;
     $38 = $37;
     $39 = HEAP32[$38>>2]|0;
     $40 = (($37) + 4)|0;
     $41 = $40;
     $42 = HEAP32[$41>>2]|0;
     $arglist_next9 = ((($36)) + 8|0);
     HEAP32[$ap>>2] = $arglist_next9;
     $43 = $arg;
     $44 = $43;
     HEAP32[$44>>2] = $39;
     $45 = (($43) + 4)|0;
     $46 = $45;
     HEAP32[$46>>2] = $42;
     break L1;
     break;
    }
    case 13:  {
     $arglist_current11 = HEAP32[$ap>>2]|0;
     $47 = $arglist_current11;
     $48 = ((0) + 4|0);
     $expanded53 = $48;
     $expanded52 = (($expanded53) - 1)|0;
     $49 = (($47) + ($expanded52))|0;
     $50 = ((0) + 4|0);
     $expanded57 = $50;
     $expanded56 = (($expanded57) - 1)|0;
     $expanded55 = $expanded56 ^ -1;
     $51 = $49 & $expanded55;
     $52 = $51;
     $53 = HEAP32[$52>>2]|0;
     $arglist_next12 = ((($52)) + 4|0);
     HEAP32[$ap>>2] = $arglist_next12;
     $conv16 = $53&65535;
     $54 = $conv16 << 16 >> 16;
     $55 = ($54|0)<(0);
     $56 = $55 << 31 >> 31;
     $57 = $arg;
     $58 = $57;
     HEAP32[$58>>2] = $54;
     $59 = (($57) + 4)|0;
     $60 = $59;
     HEAP32[$60>>2] = $56;
     break L1;
     break;
    }
    case 14:  {
     $arglist_current14 = HEAP32[$ap>>2]|0;
     $61 = $arglist_current14;
     $62 = ((0) + 4|0);
     $expanded60 = $62;
     $expanded59 = (($expanded60) - 1)|0;
     $63 = (($61) + ($expanded59))|0;
     $64 = ((0) + 4|0);
     $expanded64 = $64;
     $expanded63 = (($expanded64) - 1)|0;
     $expanded62 = $expanded63 ^ -1;
     $65 = $63 & $expanded62;
     $66 = $65;
     $67 = HEAP32[$66>>2]|0;
     $arglist_next15 = ((($66)) + 4|0);
     HEAP32[$ap>>2] = $arglist_next15;
     $conv22$mask = $67 & 65535;
     $68 = $arg;
     $69 = $68;
     HEAP32[$69>>2] = $conv22$mask;
     $70 = (($68) + 4)|0;
     $71 = $70;
     HEAP32[$71>>2] = 0;
     break L1;
     break;
    }
    case 15:  {
     $arglist_current17 = HEAP32[$ap>>2]|0;
     $72 = $arglist_current17;
     $73 = ((0) + 4|0);
     $expanded67 = $73;
     $expanded66 = (($expanded67) - 1)|0;
     $74 = (($72) + ($expanded66))|0;
     $75 = ((0) + 4|0);
     $expanded71 = $75;
     $expanded70 = (($expanded71) - 1)|0;
     $expanded69 = $expanded70 ^ -1;
     $76 = $74 & $expanded69;
     $77 = $76;
     $78 = HEAP32[$77>>2]|0;
     $arglist_next18 = ((($77)) + 4|0);
     HEAP32[$ap>>2] = $arglist_next18;
     $conv28 = $78&255;
     $79 = $conv28 << 24 >> 24;
     $80 = ($79|0)<(0);
     $81 = $80 << 31 >> 31;
     $82 = $arg;
     $83 = $82;
     HEAP32[$83>>2] = $79;
     $84 = (($82) + 4)|0;
     $85 = $84;
     HEAP32[$85>>2] = $81;
     break L1;
     break;
    }
    case 16:  {
     $arglist_current20 = HEAP32[$ap>>2]|0;
     $86 = $arglist_current20;
     $87 = ((0) + 4|0);
     $expanded74 = $87;
     $expanded73 = (($expanded74) - 1)|0;
     $88 = (($86) + ($expanded73))|0;
     $89 = ((0) + 4|0);
     $expanded78 = $89;
     $expanded77 = (($expanded78) - 1)|0;
     $expanded76 = $expanded77 ^ -1;
     $90 = $88 & $expanded76;
     $91 = $90;
     $92 = HEAP32[$91>>2]|0;
     $arglist_next21 = ((($91)) + 4|0);
     HEAP32[$ap>>2] = $arglist_next21;
     $conv34$mask = $92 & 255;
     $93 = $arg;
     $94 = $93;
     HEAP32[$94>>2] = $conv34$mask;
     $95 = (($93) + 4)|0;
     $96 = $95;
     HEAP32[$96>>2] = 0;
     break L1;
     break;
    }
    case 17:  {
     $arglist_current23 = HEAP32[$ap>>2]|0;
     $97 = $arglist_current23;
     $98 = ((0) + 8|0);
     $expanded81 = $98;
     $expanded80 = (($expanded81) - 1)|0;
     $99 = (($97) + ($expanded80))|0;
     $100 = ((0) + 8|0);
     $expanded85 = $100;
     $expanded84 = (($expanded85) - 1)|0;
     $expanded83 = $expanded84 ^ -1;
     $101 = $99 & $expanded83;
     $102 = $101;
     $103 = +HEAPF64[$102>>3];
     $arglist_next24 = ((($102)) + 8|0);
     HEAP32[$ap>>2] = $arglist_next24;
     HEAPF64[$arg>>3] = $103;
     break L1;
     break;
    }
    case 18:  {
     FUNCTION_TABLE_vii[$pop_arg_long_double & 7]($arg,$ap);
     break L1;
     break;
    }
    default: {
     break L1;
    }
    }
   } while(0);
  }
 } while(0);
 return;
}
function _fmt_x($0,$1,$s,$lower) {
 $0 = $0|0;
 $1 = $1|0;
 $s = $s|0;
 $lower = $lower|0;
 var $10 = 0, $11 = 0, $12 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $arrayidx = 0, $conv1 = 0, $conv4 = 0, $idxprom = 0, $incdec$ptr = 0, $or = 0, $s$addr$0$lcssa = 0, $s$addr$06 = 0, label = 0;
 var sp = 0;
 sp = STACKTOP;
 $2 = ($0|0)==(0);
 $3 = ($1|0)==(0);
 $4 = $2 & $3;
 if ($4) {
  $s$addr$0$lcssa = $s;
 } else {
  $5 = $0;$7 = $1;$s$addr$06 = $s;
  while(1) {
   $idxprom = $5 & 15;
   $arrayidx = (480 + ($idxprom)|0);
   $6 = HEAP8[$arrayidx>>0]|0;
   $conv4 = $6&255;
   $or = $conv4 | $lower;
   $conv1 = $or&255;
   $incdec$ptr = ((($s$addr$06)) + -1|0);
   HEAP8[$incdec$ptr>>0] = $conv1;
   $8 = (_bitshift64Lshr(($5|0),($7|0),4)|0);
   $9 = (getTempRet0() | 0);
   $10 = ($8|0)==(0);
   $11 = ($9|0)==(0);
   $12 = $10 & $11;
   if ($12) {
    $s$addr$0$lcssa = $incdec$ptr;
    break;
   } else {
    $5 = $8;$7 = $9;$s$addr$06 = $incdec$ptr;
   }
  }
 }
 return ($s$addr$0$lcssa|0);
}
function _fmt_o($0,$1,$s) {
 $0 = $0|0;
 $1 = $1|0;
 $s = $s|0;
 var $10 = 0, $11 = 0, $12 = 0, $13 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $conv = 0, $incdec$ptr = 0, $s$addr$0$lcssa = 0, $s$addr$06 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = ($0|0)==(0);
 $3 = ($1|0)==(0);
 $4 = $2 & $3;
 if ($4) {
  $s$addr$0$lcssa = $s;
 } else {
  $6 = $0;$8 = $1;$s$addr$06 = $s;
  while(1) {
   $5 = $6&255;
   $7 = $5 & 7;
   $conv = $7 | 48;
   $incdec$ptr = ((($s$addr$06)) + -1|0);
   HEAP8[$incdec$ptr>>0] = $conv;
   $9 = (_bitshift64Lshr(($6|0),($8|0),3)|0);
   $10 = (getTempRet0() | 0);
   $11 = ($9|0)==(0);
   $12 = ($10|0)==(0);
   $13 = $11 & $12;
   if ($13) {
    $s$addr$0$lcssa = $incdec$ptr;
    break;
   } else {
    $6 = $9;$8 = $10;$s$addr$06 = $incdec$ptr;
   }
  }
 }
 return ($s$addr$0$lcssa|0);
}
function _fmt_u($0,$1,$s) {
 $0 = $0|0;
 $1 = $1|0;
 $s = $s|0;
 var $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0;
 var $8 = 0, $9 = 0, $add5 = 0, $conv = 0, $conv6 = 0, $div9 = 0, $incdec$ptr = 0, $incdec$ptr7 = 0, $s$addr$0$lcssa = 0, $s$addr$013 = 0, $s$addr$1$lcssa = 0, $s$addr$19 = 0, $tobool8 = 0, $x$addr$0$lcssa$off0 = 0, $y$010 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = ($1>>>0)>(0);
 $3 = ($0>>>0)>(4294967295);
 $4 = ($1|0)==(0);
 $5 = $4 & $3;
 $6 = $2 | $5;
 if ($6) {
  $7 = $0;$8 = $1;$s$addr$013 = $s;
  while(1) {
   $9 = (___udivdi3(($7|0),($8|0),10,0)|0);
   $10 = (getTempRet0() | 0);
   $11 = (___muldi3(($9|0),($10|0),10,0)|0);
   $12 = (getTempRet0() | 0);
   $13 = (_i64Subtract(($7|0),($8|0),($11|0),($12|0))|0);
   $14 = (getTempRet0() | 0);
   $15 = $13&255;
   $conv = $15 | 48;
   $incdec$ptr = ((($s$addr$013)) + -1|0);
   HEAP8[$incdec$ptr>>0] = $conv;
   $16 = ($8>>>0)>(9);
   $17 = ($7>>>0)>(4294967295);
   $18 = ($8|0)==(9);
   $19 = $18 & $17;
   $20 = $16 | $19;
   if ($20) {
    $7 = $9;$8 = $10;$s$addr$013 = $incdec$ptr;
   } else {
    break;
   }
  }
  $s$addr$0$lcssa = $incdec$ptr;$x$addr$0$lcssa$off0 = $9;
 } else {
  $s$addr$0$lcssa = $s;$x$addr$0$lcssa$off0 = $0;
 }
 $tobool8 = ($x$addr$0$lcssa$off0|0)==(0);
 if ($tobool8) {
  $s$addr$1$lcssa = $s$addr$0$lcssa;
 } else {
  $s$addr$19 = $s$addr$0$lcssa;$y$010 = $x$addr$0$lcssa$off0;
  while(1) {
   $div9 = (($y$010>>>0) / 10)&-1;
   $21 = ($div9*10)|0;
   $22 = (($y$010) - ($21))|0;
   $add5 = $22 | 48;
   $conv6 = $add5&255;
   $incdec$ptr7 = ((($s$addr$19)) + -1|0);
   HEAP8[$incdec$ptr7>>0] = $conv6;
   $23 = ($y$010>>>0)<(10);
   if ($23) {
    $s$addr$1$lcssa = $incdec$ptr7;
    break;
   } else {
    $s$addr$19 = $incdec$ptr7;$y$010 = $div9;
   }
  }
 }
 return ($s$addr$1$lcssa|0);
}
function _memchr($src,$c,$n) {
 $src = $src|0;
 $c = $c|0;
 $n = $n|0;
 var $$in = 0, $0 = 0, $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $and = 0, $and15 = 0, $and16 = 0, $and39 = 0, $cmp = 0, $cmp11 = 0, $cmp1132 = 0, $cmp28 = 0, $cmp8 = 0, $conv1 = 0;
 var $dec = 0, $dec34 = 0, $incdec$ptr = 0, $incdec$ptr21 = 0, $incdec$ptr33 = 0, $mul = 0, $n$addr$0$lcssa = 0, $n$addr$0$lcssa52 = 0, $n$addr$043 = 0, $n$addr$1$lcssa = 0, $n$addr$1$lcssa55 = 0, $n$addr$133 = 0, $n$addr$227 = 0, $neg = 0, $or$cond = 0, $or$cond42 = 0, $s$0$lcssa = 0, $s$0$lcssa53 = 0, $s$044 = 0, $s$128 = 0;
 var $sub = 0, $sub22 = 0, $tobool = 0, $tobool17 = 0, $tobool2 = 0, $tobool2$lcssa = 0, $tobool241 = 0, $tobool25 = 0, $tobool2526 = 0, $tobool36 = 0, $tobool40 = 0, $w$0$lcssa = 0, $w$034 = 0, $xor = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $conv1 = $c & 255;
 $0 = $src;
 $and39 = $0 & 3;
 $tobool40 = ($and39|0)!=(0);
 $tobool241 = ($n|0)!=(0);
 $or$cond42 = $tobool241 & $tobool40;
 L1: do {
  if ($or$cond42) {
   $1 = $c&255;
   $n$addr$043 = $n;$s$044 = $src;
   while(1) {
    $2 = HEAP8[$s$044>>0]|0;
    $cmp = ($2<<24>>24)==($1<<24>>24);
    if ($cmp) {
     $n$addr$0$lcssa52 = $n$addr$043;$s$0$lcssa53 = $s$044;
     label = 6;
     break L1;
    }
    $incdec$ptr = ((($s$044)) + 1|0);
    $dec = (($n$addr$043) + -1)|0;
    $3 = $incdec$ptr;
    $and = $3 & 3;
    $tobool = ($and|0)!=(0);
    $tobool2 = ($dec|0)!=(0);
    $or$cond = $tobool2 & $tobool;
    if ($or$cond) {
     $n$addr$043 = $dec;$s$044 = $incdec$ptr;
    } else {
     $n$addr$0$lcssa = $dec;$s$0$lcssa = $incdec$ptr;$tobool2$lcssa = $tobool2;
     label = 5;
     break;
    }
   }
  } else {
   $n$addr$0$lcssa = $n;$s$0$lcssa = $src;$tobool2$lcssa = $tobool241;
   label = 5;
  }
 } while(0);
 if ((label|0) == 5) {
  if ($tobool2$lcssa) {
   $n$addr$0$lcssa52 = $n$addr$0$lcssa;$s$0$lcssa53 = $s$0$lcssa;
   label = 6;
  } else {
   label = 16;
  }
 }
 L8: do {
  if ((label|0) == 6) {
   $4 = HEAP8[$s$0$lcssa53>>0]|0;
   $5 = $c&255;
   $cmp8 = ($4<<24>>24)==($5<<24>>24);
   if ($cmp8) {
    $tobool36 = ($n$addr$0$lcssa52|0)==(0);
    if ($tobool36) {
     label = 16;
     break;
    } else {
     $8 = $s$0$lcssa53;
     break;
    }
   }
   $mul = Math_imul($conv1, 16843009)|0;
   $cmp1132 = ($n$addr$0$lcssa52>>>0)>(3);
   L13: do {
    if ($cmp1132) {
     $n$addr$133 = $n$addr$0$lcssa52;$w$034 = $s$0$lcssa53;
     while(1) {
      $6 = HEAP32[$w$034>>2]|0;
      $xor = $6 ^ $mul;
      $sub = (($xor) + -16843009)|0;
      $neg = $xor & -2139062144;
      $and15 = $neg ^ -2139062144;
      $and16 = $and15 & $sub;
      $tobool17 = ($and16|0)==(0);
      if (!($tobool17)) {
       $$in = $w$034;$n$addr$1$lcssa55 = $n$addr$133;
       break L13;
      }
      $incdec$ptr21 = ((($w$034)) + 4|0);
      $sub22 = (($n$addr$133) + -4)|0;
      $cmp11 = ($sub22>>>0)>(3);
      if ($cmp11) {
       $n$addr$133 = $sub22;$w$034 = $incdec$ptr21;
      } else {
       $n$addr$1$lcssa = $sub22;$w$0$lcssa = $incdec$ptr21;
       label = 11;
       break;
      }
     }
    } else {
     $n$addr$1$lcssa = $n$addr$0$lcssa52;$w$0$lcssa = $s$0$lcssa53;
     label = 11;
    }
   } while(0);
   if ((label|0) == 11) {
    $tobool2526 = ($n$addr$1$lcssa|0)==(0);
    if ($tobool2526) {
     label = 16;
     break;
    } else {
     $$in = $w$0$lcssa;$n$addr$1$lcssa55 = $n$addr$1$lcssa;
    }
   }
   $n$addr$227 = $n$addr$1$lcssa55;$s$128 = $$in;
   while(1) {
    $7 = HEAP8[$s$128>>0]|0;
    $cmp28 = ($7<<24>>24)==($5<<24>>24);
    if ($cmp28) {
     $8 = $s$128;
     break L8;
    }
    $incdec$ptr33 = ((($s$128)) + 1|0);
    $dec34 = (($n$addr$227) + -1)|0;
    $tobool25 = ($dec34|0)==(0);
    if ($tobool25) {
     label = 16;
     break;
    } else {
     $n$addr$227 = $dec34;$s$128 = $incdec$ptr33;
    }
   }
  }
 } while(0);
 if ((label|0) == 16) {
  $8 = 0;
 }
 return ($8|0);
}
function _pad_667($f,$c,$w,$l,$fl) {
 $f = $f|0;
 $c = $c|0;
 $w = $w|0;
 $l = $l|0;
 $fl = $fl|0;
 var $0 = 0, $1 = 0, $2 = 0, $and = 0, $cmp = 0, $cmp3 = 0, $cmp38 = 0, $cond = 0, $conv = 0, $l$addr$0$lcssa = 0, $l$addr$09 = 0, $or$cond = 0, $pad = 0, $sub = 0, $sub6 = 0, $tobool = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 256|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(256|0);
 $pad = sp;
 $and = $fl & 73728;
 $tobool = ($and|0)==(0);
 $cmp = ($w|0)>($l|0);
 $or$cond = $cmp & $tobool;
 if ($or$cond) {
  $sub = (($w) - ($l))|0;
  $conv = $c << 24 >> 24;
  $0 = ($sub>>>0)<(256);
  $cond = $0 ? $sub : 256;
  (_memset(($pad|0),($conv|0),($cond|0))|0);
  $cmp38 = ($sub>>>0)>(255);
  if ($cmp38) {
   $1 = (($w) - ($l))|0;
   $l$addr$09 = $sub;
   while(1) {
    _out($f,$pad,256);
    $sub6 = (($l$addr$09) + -256)|0;
    $cmp3 = ($sub6>>>0)>(255);
    if ($cmp3) {
     $l$addr$09 = $sub6;
    } else {
     break;
    }
   }
   $2 = $1 & 255;
   $l$addr$0$lcssa = $2;
  } else {
   $l$addr$0$lcssa = $sub;
  }
  _out($f,$pad,$l$addr$0$lcssa);
 }
 STACKTOP = sp;return;
}
function _wctomb($s,$wc) {
 $s = $s|0;
 $wc = $wc|0;
 var $call = 0, $retval$0 = 0, $tobool = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $tobool = ($s|0)==(0|0);
 if ($tobool) {
  $retval$0 = 0;
 } else {
  $call = (_wcrtomb($s,$wc,0)|0);
  $retval$0 = $call;
 }
 return ($retval$0|0);
}
function _wcrtomb($s,$wc,$st) {
 $s = $s|0;
 $wc = $wc|0;
 $st = $st|0;
 var $0 = 0, $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $and = 0, $and32 = 0, $and36 = 0, $and49 = 0, $and54 = 0, $and58 = 0, $call = 0, $call10 = 0, $call66 = 0, $cmp = 0;
 var $cmp14 = 0, $cmp21 = 0, $cmp24 = 0, $cmp41 = 0, $cmp7 = 0, $conv = 0, $conv12 = 0, $conv17 = 0, $conv19 = 0, $conv29 = 0, $conv34 = 0, $conv38 = 0, $conv46 = 0, $conv51 = 0, $conv56 = 0, $conv60 = 0, $incdec$ptr = 0, $incdec$ptr30 = 0, $incdec$ptr35 = 0, $incdec$ptr47 = 0;
 var $incdec$ptr52 = 0, $incdec$ptr57 = 0, $locale = 0, $or = 0, $or$cond = 0, $or18 = 0, $or28 = 0, $or33 = 0, $or37 = 0, $or45 = 0, $or50 = 0, $or55 = 0, $or59 = 0, $retval$0 = 0, $sub40 = 0, $tobool = 0, $tobool2 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $tobool = ($s|0)==(0|0);
 do {
  if ($tobool) {
   $retval$0 = 1;
  } else {
   $cmp = ($wc>>>0)<(128);
   if ($cmp) {
    $conv = $wc&255;
    HEAP8[$s>>0] = $conv;
    $retval$0 = 1;
    break;
   }
   $call = (___pthread_self_423()|0);
   $locale = ((($call)) + 188|0);
   $0 = HEAP32[$locale>>2]|0;
   $1 = HEAP32[$0>>2]|0;
   $tobool2 = ($1|0)==(0|0);
   if ($tobool2) {
    $2 = $wc & -128;
    $cmp7 = ($2|0)==(57216);
    if ($cmp7) {
     $conv12 = $wc&255;
     HEAP8[$s>>0] = $conv12;
     $retval$0 = 1;
     break;
    } else {
     $call10 = (___errno_location()|0);
     HEAP32[$call10>>2] = 84;
     $retval$0 = -1;
     break;
    }
   }
   $cmp14 = ($wc>>>0)<(2048);
   if ($cmp14) {
    $3 = $wc >>> 6;
    $or = $3 | 192;
    $conv17 = $or&255;
    $incdec$ptr = ((($s)) + 1|0);
    HEAP8[$s>>0] = $conv17;
    $and = $wc & 63;
    $or18 = $and | 128;
    $conv19 = $or18&255;
    HEAP8[$incdec$ptr>>0] = $conv19;
    $retval$0 = 2;
    break;
   }
   $cmp21 = ($wc>>>0)<(55296);
   $4 = $wc & -8192;
   $cmp24 = ($4|0)==(57344);
   $or$cond = $cmp21 | $cmp24;
   if ($or$cond) {
    $5 = $wc >>> 12;
    $or28 = $5 | 224;
    $conv29 = $or28&255;
    $incdec$ptr30 = ((($s)) + 1|0);
    HEAP8[$s>>0] = $conv29;
    $6 = $wc >>> 6;
    $and32 = $6 & 63;
    $or33 = $and32 | 128;
    $conv34 = $or33&255;
    $incdec$ptr35 = ((($s)) + 2|0);
    HEAP8[$incdec$ptr30>>0] = $conv34;
    $and36 = $wc & 63;
    $or37 = $and36 | 128;
    $conv38 = $or37&255;
    HEAP8[$incdec$ptr35>>0] = $conv38;
    $retval$0 = 3;
    break;
   }
   $sub40 = (($wc) + -65536)|0;
   $cmp41 = ($sub40>>>0)<(1048576);
   if ($cmp41) {
    $7 = $wc >>> 18;
    $or45 = $7 | 240;
    $conv46 = $or45&255;
    $incdec$ptr47 = ((($s)) + 1|0);
    HEAP8[$s>>0] = $conv46;
    $8 = $wc >>> 12;
    $and49 = $8 & 63;
    $or50 = $and49 | 128;
    $conv51 = $or50&255;
    $incdec$ptr52 = ((($s)) + 2|0);
    HEAP8[$incdec$ptr47>>0] = $conv51;
    $9 = $wc >>> 6;
    $and54 = $9 & 63;
    $or55 = $and54 | 128;
    $conv56 = $or55&255;
    $incdec$ptr57 = ((($s)) + 3|0);
    HEAP8[$incdec$ptr52>>0] = $conv56;
    $and58 = $wc & 63;
    $or59 = $and58 | 128;
    $conv60 = $or59&255;
    HEAP8[$incdec$ptr57>>0] = $conv60;
    $retval$0 = 4;
    break;
   } else {
    $call66 = (___errno_location()|0);
    HEAP32[$call66>>2] = 84;
    $retval$0 = -1;
    break;
   }
  }
 } while(0);
 return ($retval$0|0);
}
function ___pthread_self_423() {
 var $call = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $call = (_pthread_self()|0);
 return ($call|0);
}
function _pthread_self() {
 var label = 0, sp = 0;
 sp = STACKTOP;
 return (648|0);
}
function ___fwritex($s,$l,$f) {
 $s = $s|0;
 $l = $l|0;
 $f = $f|0;
 var $$pre = 0, $$pre35 = 0, $0 = 0, $1 = 0, $10 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $add = 0, $add$ptr = 0, $add$ptr27 = 0, $arrayidx = 0, $call = 0, $call16 = 0, $call4 = 0;
 var $cmp = 0, $cmp11 = 0, $cmp17 = 0, $cmp6 = 0, $i$033 = 0, $i$1 = 0, $l$addr$0 = 0, $l$addr$1 = 0, $lbf = 0, $or$cond = 0, $retval$1 = 0, $s$addr$1 = 0, $sub = 0, $sub$ptr$sub = 0, $tobool = 0, $tobool1 = 0, $tobool9 = 0, $tobool932 = 0, $wend = 0, $wpos = 0;
 var $write = 0, $write15 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $wend = ((($f)) + 16|0);
 $0 = HEAP32[$wend>>2]|0;
 $tobool = ($0|0)==(0|0);
 if ($tobool) {
  $call = (___towrite($f)|0);
  $tobool1 = ($call|0)==(0);
  if ($tobool1) {
   $$pre = HEAP32[$wend>>2]|0;
   $3 = $$pre;
   label = 5;
  } else {
   $retval$1 = 0;
  }
 } else {
  $1 = $0;
  $3 = $1;
  label = 5;
 }
 L5: do {
  if ((label|0) == 5) {
   $wpos = ((($f)) + 20|0);
   $2 = HEAP32[$wpos>>2]|0;
   $sub$ptr$sub = (($3) - ($2))|0;
   $cmp = ($sub$ptr$sub>>>0)<($l>>>0);
   $4 = $2;
   if ($cmp) {
    $write = ((($f)) + 36|0);
    $5 = HEAP32[$write>>2]|0;
    $call4 = (FUNCTION_TABLE_iiii[$5 & 7]($f,$s,$l)|0);
    $retval$1 = $call4;
    break;
   }
   $lbf = ((($f)) + 75|0);
   $6 = HEAP8[$lbf>>0]|0;
   $cmp6 = ($6<<24>>24)<(0);
   $tobool932 = ($l|0)==(0);
   $or$cond = $cmp6 | $tobool932;
   L10: do {
    if ($or$cond) {
     $9 = $4;$i$1 = 0;$l$addr$1 = $l;$s$addr$1 = $s;
    } else {
     $i$033 = $l;
     while(1) {
      $sub = (($i$033) + -1)|0;
      $arrayidx = (($s) + ($sub)|0);
      $7 = HEAP8[$arrayidx>>0]|0;
      $cmp11 = ($7<<24>>24)==(10);
      if ($cmp11) {
       break;
      }
      $tobool9 = ($sub|0)==(0);
      if ($tobool9) {
       $9 = $4;$i$1 = 0;$l$addr$1 = $l;$s$addr$1 = $s;
       break L10;
      } else {
       $i$033 = $sub;
      }
     }
     $write15 = ((($f)) + 36|0);
     $8 = HEAP32[$write15>>2]|0;
     $call16 = (FUNCTION_TABLE_iiii[$8 & 7]($f,$s,$i$033)|0);
     $cmp17 = ($call16>>>0)<($i$033>>>0);
     if ($cmp17) {
      $retval$1 = $call16;
      break L5;
     }
     $add$ptr = (($s) + ($i$033)|0);
     $l$addr$0 = (($l) - ($i$033))|0;
     $$pre35 = HEAP32[$wpos>>2]|0;
     $9 = $$pre35;$i$1 = $i$033;$l$addr$1 = $l$addr$0;$s$addr$1 = $add$ptr;
    }
   } while(0);
   (_memcpy(($9|0),($s$addr$1|0),($l$addr$1|0))|0);
   $10 = HEAP32[$wpos>>2]|0;
   $add$ptr27 = (($10) + ($l$addr$1)|0);
   HEAP32[$wpos>>2] = $add$ptr27;
   $add = (($i$1) + ($l$addr$1))|0;
   $retval$1 = $add;
  }
 } while(0);
 return ($retval$1|0);
}
function ___towrite($f) {
 $f = $f|0;
 var $0 = 0, $1 = 0, $2 = 0, $3 = 0, $4 = 0, $add$ptr = 0, $and = 0, $buf = 0, $buf_size = 0, $conv = 0, $conv3 = 0, $mode = 0, $or = 0, $or5 = 0, $rend = 0, $retval$0 = 0, $rpos = 0, $sub = 0, $tobool = 0, $wbase = 0;
 var $wend = 0, $wpos = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $mode = ((($f)) + 74|0);
 $0 = HEAP8[$mode>>0]|0;
 $conv = $0 << 24 >> 24;
 $sub = (($conv) + 255)|0;
 $or = $sub | $conv;
 $conv3 = $or&255;
 HEAP8[$mode>>0] = $conv3;
 $1 = HEAP32[$f>>2]|0;
 $and = $1 & 8;
 $tobool = ($and|0)==(0);
 if ($tobool) {
  $rend = ((($f)) + 8|0);
  HEAP32[$rend>>2] = 0;
  $rpos = ((($f)) + 4|0);
  HEAP32[$rpos>>2] = 0;
  $buf = ((($f)) + 44|0);
  $2 = HEAP32[$buf>>2]|0;
  $wbase = ((($f)) + 28|0);
  HEAP32[$wbase>>2] = $2;
  $wpos = ((($f)) + 20|0);
  HEAP32[$wpos>>2] = $2;
  $3 = $2;
  $buf_size = ((($f)) + 48|0);
  $4 = HEAP32[$buf_size>>2]|0;
  $add$ptr = (($3) + ($4)|0);
  $wend = ((($f)) + 16|0);
  HEAP32[$wend>>2] = $add$ptr;
  $retval$0 = 0;
 } else {
  $or5 = $1 | 32;
  HEAP32[$f>>2] = $or5;
  $retval$0 = -1;
 }
 return ($retval$0|0);
}
function ___DOUBLE_BITS_670($__f) {
 $__f = +$__f;
 var $0 = 0, $1 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 HEAPF64[tempDoublePtr>>3] = $__f;$0 = HEAP32[tempDoublePtr>>2]|0;
 $1 = HEAP32[tempDoublePtr+4>>2]|0;
 setTempRet0(($1) | 0);
 return ($0|0);
}
function _frexp($x,$e) {
 $x = +$x;
 $e = $e|0;
 var $0 = 0, $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0.0, $call = 0.0, $conv = 0, $mul = 0.0, $retval$0 = 0.0, $storemerge = 0, $sub = 0, $sub8 = 0, $tobool1 = 0, $trunc$clear = 0, $x$addr$0 = 0.0, label = 0;
 var sp = 0;
 sp = STACKTOP;
 HEAPF64[tempDoublePtr>>3] = $x;$0 = HEAP32[tempDoublePtr>>2]|0;
 $1 = HEAP32[tempDoublePtr+4>>2]|0;
 $2 = (_bitshift64Lshr(($0|0),($1|0),52)|0);
 $3 = (getTempRet0() | 0);
 $4 = $2&65535;
 $trunc$clear = $4 & 2047;
 switch ($trunc$clear<<16>>16) {
 case 0:  {
  $tobool1 = $x != 0.0;
  if ($tobool1) {
   $mul = $x * 1.8446744073709552E+19;
   $call = (+_frexp($mul,$e));
   $5 = HEAP32[$e>>2]|0;
   $sub = (($5) + -64)|0;
   $storemerge = $sub;$x$addr$0 = $call;
  } else {
   $storemerge = 0;$x$addr$0 = $x;
  }
  HEAP32[$e>>2] = $storemerge;
  $retval$0 = $x$addr$0;
  break;
 }
 case 2047:  {
  $retval$0 = $x;
  break;
 }
 default: {
  $conv = $2 & 2047;
  $sub8 = (($conv) + -1022)|0;
  HEAP32[$e>>2] = $sub8;
  $6 = $1 & -2146435073;
  $7 = $6 | 1071644672;
  HEAP32[tempDoublePtr>>2] = $0;HEAP32[tempDoublePtr+4>>2] = $7;$8 = +HEAPF64[tempDoublePtr>>3];
  $retval$0 = $8;
 }
 }
 return (+$retval$0);
}
function ___ofl_lock() {
 var label = 0, sp = 0;
 sp = STACKTOP;
 ___lock((2212|0));
 return (2220|0);
}
function ___ofl_unlock() {
 var label = 0, sp = 0;
 sp = STACKTOP;
 ___unlock((2212|0));
 return;
}
function _fflush($f) {
 $f = $f|0;
 var $0 = 0, $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $call = 0, $call1 = 0, $call11 = 0, $call118 = 0, $call17 = 0, $call23 = 0, $call7 = 0, $cmp = 0, $cmp15 = 0, $cmp21 = 0, $cond10 = 0, $cond20 = 0, $f$addr$0 = 0, $f$addr$019 = 0;
 var $f$addr$022 = 0, $lock = 0, $lock14 = 0, $next = 0, $or = 0, $phitmp = 0, $r$0$lcssa = 0, $r$021 = 0, $r$1 = 0, $retval$0 = 0, $tobool = 0, $tobool12 = 0, $tobool1220 = 0, $tobool25 = 0, $tobool5 = 0, $wbase = 0, $wpos = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $tobool = ($f|0)==(0|0);
 do {
  if ($tobool) {
   $1 = HEAP32[161]|0;
   $tobool5 = ($1|0)==(0|0);
   if ($tobool5) {
    $cond10 = 0;
   } else {
    $2 = HEAP32[161]|0;
    $call7 = (_fflush($2)|0);
    $cond10 = $call7;
   }
   $call11 = (___ofl_lock()|0);
   $f$addr$019 = HEAP32[$call11>>2]|0;
   $tobool1220 = ($f$addr$019|0)==(0|0);
   if ($tobool1220) {
    $r$0$lcssa = $cond10;
   } else {
    $f$addr$022 = $f$addr$019;$r$021 = $cond10;
    while(1) {
     $lock14 = ((($f$addr$022)) + 76|0);
     $3 = HEAP32[$lock14>>2]|0;
     $cmp15 = ($3|0)>(-1);
     if ($cmp15) {
      $call17 = (___lockfile($f$addr$022)|0);
      $cond20 = $call17;
     } else {
      $cond20 = 0;
     }
     $wpos = ((($f$addr$022)) + 20|0);
     $4 = HEAP32[$wpos>>2]|0;
     $wbase = ((($f$addr$022)) + 28|0);
     $5 = HEAP32[$wbase>>2]|0;
     $cmp21 = ($4>>>0)>($5>>>0);
     if ($cmp21) {
      $call23 = (___fflush_unlocked($f$addr$022)|0);
      $or = $call23 | $r$021;
      $r$1 = $or;
     } else {
      $r$1 = $r$021;
     }
     $tobool25 = ($cond20|0)==(0);
     if (!($tobool25)) {
      ___unlockfile($f$addr$022);
     }
     $next = ((($f$addr$022)) + 56|0);
     $f$addr$0 = HEAP32[$next>>2]|0;
     $tobool12 = ($f$addr$0|0)==(0|0);
     if ($tobool12) {
      $r$0$lcssa = $r$1;
      break;
     } else {
      $f$addr$022 = $f$addr$0;$r$021 = $r$1;
     }
    }
   }
   ___ofl_unlock();
   $retval$0 = $r$0$lcssa;
  } else {
   $lock = ((($f)) + 76|0);
   $0 = HEAP32[$lock>>2]|0;
   $cmp = ($0|0)>(-1);
   if (!($cmp)) {
    $call118 = (___fflush_unlocked($f)|0);
    $retval$0 = $call118;
    break;
   }
   $call = (___lockfile($f)|0);
   $phitmp = ($call|0)==(0);
   $call1 = (___fflush_unlocked($f)|0);
   if ($phitmp) {
    $retval$0 = $call1;
   } else {
    ___unlockfile($f);
    $retval$0 = $call1;
   }
  }
 } while(0);
 return ($retval$0|0);
}
function ___fflush_unlocked($f) {
 $f = $f|0;
 var $0 = 0, $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $cmp = 0, $cmp4 = 0, $rend = 0, $retval$0 = 0, $rpos = 0, $seek = 0, $sub$ptr$lhs$cast = 0, $sub$ptr$rhs$cast = 0, $sub$ptr$sub = 0, $tobool = 0;
 var $wbase = 0, $wend = 0, $wpos = 0, $write = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $wpos = ((($f)) + 20|0);
 $0 = HEAP32[$wpos>>2]|0;
 $wbase = ((($f)) + 28|0);
 $1 = HEAP32[$wbase>>2]|0;
 $cmp = ($0>>>0)>($1>>>0);
 if ($cmp) {
  $write = ((($f)) + 36|0);
  $2 = HEAP32[$write>>2]|0;
  (FUNCTION_TABLE_iiii[$2 & 7]($f,0,0)|0);
  $3 = HEAP32[$wpos>>2]|0;
  $tobool = ($3|0)==(0|0);
  if ($tobool) {
   $retval$0 = -1;
  } else {
   label = 3;
  }
 } else {
  label = 3;
 }
 if ((label|0) == 3) {
  $rpos = ((($f)) + 4|0);
  $4 = HEAP32[$rpos>>2]|0;
  $rend = ((($f)) + 8|0);
  $5 = HEAP32[$rend>>2]|0;
  $cmp4 = ($4>>>0)<($5>>>0);
  if ($cmp4) {
   $sub$ptr$lhs$cast = $4;
   $sub$ptr$rhs$cast = $5;
   $sub$ptr$sub = (($sub$ptr$lhs$cast) - ($sub$ptr$rhs$cast))|0;
   $6 = ($sub$ptr$sub|0)<(0);
   $7 = $6 << 31 >> 31;
   $seek = ((($f)) + 40|0);
   $8 = HEAP32[$seek>>2]|0;
   (FUNCTION_TABLE_iiiii[$8 & 3]($f,$sub$ptr$sub,$7,1)|0);
   $9 = (getTempRet0() | 0);
  }
  $wend = ((($f)) + 16|0);
  HEAP32[$wend>>2] = 0;
  HEAP32[$wbase>>2] = 0;
  HEAP32[$wpos>>2] = 0;
  HEAP32[$rend>>2] = 0;
  HEAP32[$rpos>>2] = 0;
  $retval$0 = 0;
 }
 return ($retval$0|0);
}
function _printf($fmt,$varargs) {
 $fmt = $fmt|0;
 $varargs = $varargs|0;
 var $0 = 0, $ap = 0, $call = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $ap = sp;
 HEAP32[$ap>>2] = $varargs;
 $0 = HEAP32[160]|0;
 $call = (_vfprintf($0,$fmt,$ap)|0);
 STACKTOP = sp;return ($call|0);
}
function _malloc($bytes) {
 $bytes = $bytes|0;
 var $$pre = 0, $$pre$i = 0, $$pre$i$i = 0, $$pre$i134 = 0, $$pre$i194 = 0, $$pre$i31$i = 0, $$pre$phi$i$iZ2D = 0, $$pre$phi$i195Z2D = 0, $$pre$phi$i32$iZ2D = 0, $$pre$phi$iZ2D = 0, $$pre$phiZ2D = 0, $0 = 0, $1 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0;
 var $106 = 0, $107 = 0, $108 = 0, $109 = 0, $11 = 0, $110 = 0, $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0, $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0;
 var $124 = 0, $125 = 0, $126 = 0, $127 = 0, $128 = 0, $129 = 0, $13 = 0, $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0, $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0;
 var $142 = 0, $143 = 0, $144 = 0, $145 = 0, $146 = 0, $147 = 0, $148 = 0, $149 = 0, $15 = 0, $150 = 0, $151 = 0, $152 = 0, $153 = 0, $154 = 0, $155 = 0, $156 = 0, $157 = 0, $158 = 0, $159 = 0, $16 = 0;
 var $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0;
 var $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0;
 var $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0;
 var $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0;
 var $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, $F$0$i$i = 0, $F104$0 = 0, $F197$0$i = 0, $F224$0$i$i = 0, $F290$0$i = 0, $I252$0$i$i = 0, $I316$0$i = 0, $I57$0$i$i = 0, $K105$010$i$i = 0;
 var $K305$08$i$i = 0, $K373$015$i = 0, $R$1$i = 0, $R$1$i$be = 0, $R$1$i$i = 0, $R$1$i$i$be = 0, $R$1$i$i$ph = 0, $R$1$i$ph = 0, $R$1$i183 = 0, $R$1$i183$be = 0, $R$1$i183$ph = 0, $R$3$i = 0, $R$3$i$i = 0, $R$3$i188 = 0, $RP$1$i = 0, $RP$1$i$be = 0, $RP$1$i$i = 0, $RP$1$i$i$be = 0, $RP$1$i$i$ph = 0, $RP$1$i$ph = 0;
 var $RP$1$i182 = 0, $RP$1$i182$be = 0, $RP$1$i182$ph = 0, $T$0$lcssa$i = 0, $T$0$lcssa$i$i = 0, $T$0$lcssa$i34$i = 0, $T$014$i = 0, $T$07$i$i = 0, $T$09$i$i = 0, $add$i = 0, $add$i$i = 0, $add$i135 = 0, $add$i155 = 0, $add$ptr = 0, $add$ptr$i = 0, $add$ptr$i$i = 0, $add$ptr$i$i$i = 0, $add$ptr$i141 = 0, $add$ptr$i174 = 0, $add$ptr$i2$i$i = 0;
 var $add$ptr$i35$i = 0, $add$ptr$i43$i = 0, $add$ptr$i57$i = 0, $add$ptr14$i$i = 0, $add$ptr15$i$i = 0, $add$ptr16$i$i = 0, $add$ptr166 = 0, $add$ptr169 = 0, $add$ptr17$i$i = 0, $add$ptr178 = 0, $add$ptr181$i = 0, $add$ptr182 = 0, $add$ptr189$i = 0, $add$ptr190$i = 0, $add$ptr193 = 0, $add$ptr199 = 0, $add$ptr2$i$i = 0, $add$ptr205$i$i = 0, $add$ptr212$i$i = 0, $add$ptr225$i = 0;
 var $add$ptr227$i = 0, $add$ptr24$i$i = 0, $add$ptr262$i = 0, $add$ptr269$i = 0, $add$ptr273$i = 0, $add$ptr282$i = 0, $add$ptr3$i$i = 0, $add$ptr30$i$i = 0, $add$ptr369$i$i = 0, $add$ptr4$i$i = 0, $add$ptr4$i$i$i = 0, $add$ptr4$i41$i = 0, $add$ptr4$i49$i = 0, $add$ptr441$i = 0, $add$ptr5$i$i = 0, $add$ptr6$i$i = 0, $add$ptr6$i$i$i = 0, $add$ptr6$i53$i = 0, $add$ptr7$i$i = 0, $add$ptr81$i$i = 0;
 var $add$ptr95 = 0, $add$ptr98 = 0, $add10$i = 0, $add101$i = 0, $add110$i = 0, $add13$i = 0, $add14$i = 0, $add140$i = 0, $add144 = 0, $add150$i = 0, $add17$i = 0, $add17$i158 = 0, $add177$i = 0, $add18$i = 0, $add19$i = 0, $add2 = 0, $add20$i = 0, $add206$i$i = 0, $add212$i = 0, $add215$i = 0;
 var $add22$i = 0, $add246$i = 0, $add26$i$i = 0, $add268$i = 0, $add269$i$i = 0, $add274$i$i = 0, $add278$i$i = 0, $add280$i$i = 0, $add283$i$i = 0, $add337$i = 0, $add342$i = 0, $add346$i = 0, $add348$i = 0, $add351$i = 0, $add46$i = 0, $add50 = 0, $add51$i = 0, $add54 = 0, $add54$i = 0, $add58 = 0;
 var $add62 = 0, $add64 = 0, $add74$i$i = 0, $add77$i = 0, $add78$i = 0, $add79$i$i = 0, $add8 = 0, $add82$i = 0, $add83$i$i = 0, $add85$i$i = 0, $add86$i = 0, $add88$i$i = 0, $add9$i = 0, $add90$i = 0, $add92$i = 0, $and = 0, $and$i = 0, $and$i$i = 0, $and$i$i$i = 0, $and$i14$i = 0;
 var $and$i152 = 0, $and$i36$i = 0, $and$i44$i = 0, $and100$i = 0, $and103$i = 0, $and104$i = 0, $and106 = 0, $and11$i = 0, $and119$i$i = 0, $and1197$i$i = 0, $and12$i = 0, $and13$i = 0, $and13$i$i = 0, $and133$i$i = 0, $and14 = 0, $and145 = 0, $and17$i = 0, $and194$i = 0, $and194$i191 = 0, $and199$i = 0;
 var $and209$i$i = 0, $and21$i = 0, $and21$i159 = 0, $and227$i$i = 0, $and236$i = 0, $and264$i$i = 0, $and268$i$i = 0, $and273$i$i = 0, $and282$i$i = 0, $and29$i = 0, $and292$i = 0, $and295$i$i = 0, $and3$i = 0, $and3$i$i = 0, $and3$i$i$i = 0, $and3$i39$i = 0, $and3$i47$i = 0, $and30$i = 0, $and318$i$i = 0, $and3185$i$i = 0;
 var $and32$i = 0, $and32$i$i = 0, $and33$i$i = 0, $and331$i = 0, $and336$i = 0, $and341$i = 0, $and350$i = 0, $and363$i = 0, $and37$i$i = 0, $and387$i = 0, $and38712$i = 0, $and4 = 0, $and40$i$i = 0, $and41 = 0, $and42$i = 0, $and43 = 0, $and46 = 0, $and49 = 0, $and49$i = 0, $and49$i$i = 0;
 var $and53 = 0, $and57 = 0, $and6$i = 0, $and6$i$i = 0, $and6$i13$i = 0, $and6$i18$i = 0, $and61 = 0, $and64$i = 0, $and68$i = 0, $and69$i$i = 0, $and7 = 0, $and73$i = 0, $and73$i$i = 0, $and74 = 0, $and77$i = 0, $and78$i$i = 0, $and8$i = 0, $and80$i = 0, $and81$i = 0, $and85$i = 0;
 var $and87$i$i = 0, $and89$i = 0, $and9$i = 0, $and96$i$i = 0, $arrayidx = 0, $arrayidx$i = 0, $arrayidx$i$i = 0, $arrayidx$i160 = 0, $arrayidx103 = 0, $arrayidx103$i$i = 0, $arrayidx106$i = 0, $arrayidx107$i$i = 0, $arrayidx113$i = 0, $arrayidx113$i173 = 0, $arrayidx121$i = 0, $arrayidx121$i$sink = 0, $arrayidx123$i$i = 0, $arrayidx126$i$i = 0, $arrayidx137$i = 0, $arrayidx143$i$i = 0;
 var $arrayidx148$i = 0, $arrayidx151$i = 0, $arrayidx151$i$i = 0, $arrayidx151$i$i$sink = 0, $arrayidx154$i = 0, $arrayidx155$i = 0, $arrayidx161$i = 0, $arrayidx165$i = 0, $arrayidx165$i185 = 0, $arrayidx178$i$i = 0, $arrayidx184$i = 0, $arrayidx184$i$i = 0, $arrayidx195$i$i = 0, $arrayidx196$i = 0, $arrayidx204$i = 0, $arrayidx212$i = 0, $arrayidx212$i$sink = 0, $arrayidx223$i$i = 0, $arrayidx228$i = 0, $arrayidx23$i = 0;
 var $arrayidx239$i = 0, $arrayidx245$i = 0, $arrayidx256$i = 0, $arrayidx27$i = 0, $arrayidx287$i$i = 0, $arrayidx289$i = 0, $arrayidx290$i$i = 0, $arrayidx325$i$i = 0, $arrayidx355$i = 0, $arrayidx358$i = 0, $arrayidx394$i = 0, $arrayidx40$i = 0, $arrayidx44$i = 0, $arrayidx61$i = 0, $arrayidx65$i = 0, $arrayidx66 = 0, $arrayidx71$i = 0, $arrayidx75$i = 0, $arrayidx91$i$i = 0, $arrayidx92$i$i = 0;
 var $arrayidx94$i = 0, $arrayidx94$i170 = 0, $arrayidx96$i$i = 0, $bk$i = 0, $bk$i$i = 0, $bk$i176 = 0, $bk$i26$i = 0, $bk102$i$i = 0, $bk122 = 0, $bk124 = 0, $bk139$i$i = 0, $bk145$i = 0, $bk158$i$i = 0, $bk161$i$i = 0, $bk18 = 0, $bk218$i = 0, $bk220$i = 0, $bk246$i$i = 0, $bk248$i$i = 0, $bk302$i$i = 0;
 var $bk311$i = 0, $bk313$i = 0, $bk338$i$i = 0, $bk357$i$i = 0, $bk360$i$i = 0, $bk370$i = 0, $bk407$i = 0, $bk429$i = 0, $bk432$i = 0, $bk55$i$i = 0, $bk56$i = 0, $bk67$i$i = 0, $bk74$i$i = 0, $bk85 = 0, $bk91$i$i = 0, $br$2$ph$i = 0, $call107$i = 0, $call131$i = 0, $call132$i = 0, $call275$i = 0;
 var $call37$i = 0, $call68$i = 0, $call83$i = 0, $child$i$i = 0, $child166$i$i = 0, $child289$i$i = 0, $child357$i = 0, $cmp = 0, $cmp$i = 0, $cmp$i$i$i = 0, $cmp$i12$i = 0, $cmp$i133 = 0, $cmp$i149 = 0, $cmp$i15$i = 0, $cmp$i3$i$i = 0, $cmp$i37$i = 0, $cmp$i45$i = 0, $cmp$i55$i = 0, $cmp1 = 0, $cmp1$i = 0;
 var $cmp10 = 0, $cmp100$i$i = 0, $cmp102$i = 0, $cmp104$i$i = 0, $cmp105$i = 0, $cmp106$i$i = 0, $cmp107$i = 0, $cmp108$i = 0, $cmp108$i$i = 0, $cmp114$i = 0, $cmp116$i = 0, $cmp118$i = 0, $cmp119$i = 0, $cmp12$i = 0, $cmp120$i$i = 0, $cmp120$i28$i = 0, $cmp1208$i$i = 0, $cmp123$i = 0, $cmp124$i$i = 0, $cmp126$i = 0;
 var $cmp127$i = 0, $cmp128 = 0, $cmp128$i = 0, $cmp128$i$i = 0, $cmp133$i = 0, $cmp135$i = 0, $cmp137$i = 0, $cmp138$i = 0, $cmp139 = 0, $cmp141$i = 0, $cmp144$i$i = 0, $cmp146 = 0, $cmp147$i = 0, $cmp14799$i = 0, $cmp15$i = 0, $cmp151$i = 0, $cmp152$i = 0, $cmp155$i = 0, $cmp156 = 0, $cmp156$i = 0;
 var $cmp156$i$i = 0, $cmp157$i = 0, $cmp159$i = 0, $cmp162 = 0, $cmp162$i = 0, $cmp162$i184 = 0, $cmp166$i = 0, $cmp168$i$i = 0, $cmp174$i = 0, $cmp180$i = 0, $cmp185$i = 0, $cmp185$i$i = 0, $cmp186 = 0, $cmp186$i = 0, $cmp19$i = 0, $cmp190$i = 0, $cmp191$i = 0, $cmp2$i$i = 0, $cmp2$i$i$i = 0, $cmp20$i$i = 0;
 var $cmp203$i = 0, $cmp205$i = 0, $cmp209$i = 0, $cmp21$i = 0, $cmp215$i$i = 0, $cmp217$i = 0, $cmp218$i = 0, $cmp224$i = 0, $cmp228$i = 0, $cmp229$i = 0, $cmp24$i = 0, $cmp24$i$i = 0, $cmp246$i = 0, $cmp254$i$i = 0, $cmp257$i = 0, $cmp258$i$i = 0, $cmp26$i = 0, $cmp265$i = 0, $cmp27$i$i = 0, $cmp28$i = 0;
 var $cmp28$i$i = 0, $cmp284$i = 0, $cmp29 = 0, $cmp3$i$i = 0, $cmp306$i$i = 0, $cmp31 = 0, $cmp319$i = 0, $cmp319$i$i = 0, $cmp3196$i$i = 0, $cmp32$i = 0, $cmp32$i138 = 0, $cmp323$i = 0, $cmp327$i$i = 0, $cmp34$i = 0, $cmp34$i$i = 0, $cmp35$i = 0, $cmp36$i = 0, $cmp36$i$i = 0, $cmp374$i = 0, $cmp38$i = 0;
 var $cmp38$i$i = 0, $cmp388$i = 0, $cmp38813$i = 0, $cmp396$i = 0, $cmp40$i = 0, $cmp43$i = 0, $cmp45$i = 0, $cmp46$i = 0, $cmp46$i$i = 0, $cmp49$i = 0, $cmp5 = 0, $cmp55$i = 0, $cmp55$i166 = 0, $cmp57$i = 0, $cmp57$i167 = 0, $cmp59$i$i = 0, $cmp60$i = 0, $cmp62$i = 0, $cmp63$i = 0, $cmp63$i$i = 0;
 var $cmp65$i = 0, $cmp66$i = 0, $cmp66$i140 = 0, $cmp69$i = 0, $cmp7$i$i = 0, $cmp70 = 0, $cmp72$i = 0, $cmp75$i$i = 0, $cmp76$i = 0, $cmp81$i = 0, $cmp85$i = 0, $cmp89$i = 0, $cmp9$i$i = 0, $cmp90$i = 0, $cmp91$i = 0, $cmp93$i = 0, $cmp95$i = 0, $cmp96$i = 0, $cmp97$i = 0, $cmp97$i$i = 0;
 var $cmp9716$i = 0, $cmp99 = 0, $cond = 0, $cond$i = 0, $cond$i$i = 0, $cond$i$i$i = 0, $cond$i17$i = 0, $cond$i40$i = 0, $cond$i48$i = 0, $cond1$i$i = 0, $cond115$i = 0, $cond115$i$i = 0, $cond13$i$i = 0, $cond15$i$i = 0, $cond2$i = 0, $cond3$i = 0, $cond315$i$i = 0, $cond383$i = 0, $cond4$i = 0, $fd$i = 0;
 var $fd$i$i = 0, $fd$i177 = 0, $fd103$i$i = 0, $fd123 = 0, $fd140$i$i = 0, $fd146$i = 0, $fd148$i$i = 0, $fd160$i$i = 0, $fd219$i = 0, $fd247$i$i = 0, $fd303$i$i = 0, $fd312$i = 0, $fd339$i$i = 0, $fd344$i$i = 0, $fd359$i$i = 0, $fd371$i = 0, $fd408$i = 0, $fd416$i = 0, $fd431$i = 0, $fd54$i$i = 0;
 var $fd57$i = 0, $fd68$i$i = 0, $fd69 = 0, $fd78$i$i = 0, $fd9 = 0, $fd92$i$i = 0, $head = 0, $head$i = 0, $head$i$i = 0, $head$i$i$i = 0, $head$i164 = 0, $head$i22$i = 0, $head$i42$i = 0, $head$i52$i = 0, $head118$i$i = 0, $head1186$i$i = 0, $head168 = 0, $head173 = 0, $head177 = 0, $head179 = 0;
 var $head179$i = 0, $head182$i = 0, $head187$i = 0, $head189$i = 0, $head195 = 0, $head198 = 0, $head208$i$i = 0, $head211$i$i = 0, $head23$i$i = 0, $head25 = 0, $head26$i$i = 0, $head265$i = 0, $head268$i = 0, $head271$i = 0, $head274$i = 0, $head279$i = 0, $head281$i = 0, $head29$i = 0, $head29$i$i = 0, $head317$i$i = 0;
 var $head3174$i$i = 0, $head32$i$i = 0, $head34$i$i = 0, $head386$i = 0, $head38611$i = 0, $head7$i$i = 0, $head7$i$i$i = 0, $head7$i54$i = 0, $head94 = 0, $head97 = 0, $head99$i = 0, $idx$0$i = 0, $index$i = 0, $index$i$i = 0, $index$i189 = 0, $index$i29$i = 0, $index288$i$i = 0, $index356$i = 0, $magic$i$i = 0, $nb$0 = 0;
 var $neg = 0, $neg$i = 0, $neg$i$i = 0, $neg$i137 = 0, $neg$i190 = 0, $neg103$i = 0, $neg13 = 0, $neg132$i$i = 0, $neg48$i = 0, $neg73 = 0, $next$i = 0, $next$i$i = 0, $next$i$i$i = 0, $next231$i = 0, $not$cmp141$i = 0, $oldfirst$0$i$i = 0, $or$cond$i = 0, $or$cond$i168 = 0, $or$cond1$i = 0, $or$cond1$i165 = 0;
 var $or$cond11$i = 0, $or$cond2$i = 0, $or$cond4$i = 0, $or$cond5$i = 0, $or$cond7$i = 0, $or$cond8$i = 0, $or$cond8$not$i = 0, $or$cond97$i = 0, $or$cond98$i = 0, $or$i = 0, $or$i$i = 0, $or$i$i$i = 0, $or$i169 = 0, $or$i51$i = 0, $or101$i$i = 0, $or110 = 0, $or167 = 0, $or172 = 0, $or176 = 0, $or178$i = 0;
 var $or180 = 0, $or183$i = 0, $or186$i = 0, $or188$i = 0, $or19$i$i = 0, $or194 = 0, $or197 = 0, $or204$i = 0, $or210$i$i = 0, $or22$i$i = 0, $or23 = 0, $or232$i$i = 0, $or26 = 0, $or264$i = 0, $or267$i = 0, $or270$i = 0, $or275$i = 0, $or278$i = 0, $or28$i$i = 0, $or280$i = 0;
 var $or297$i = 0, $or300$i$i = 0, $or33$i$i = 0, $or368$i = 0, $or40 = 0, $or44$i$i = 0, $or93 = 0, $or96 = 0, $parent$i = 0, $parent$i$i = 0, $parent$i175 = 0, $parent$i27$i = 0, $parent135$i = 0, $parent138$i$i = 0, $parent149$i = 0, $parent162$i$i = 0, $parent165$i$i = 0, $parent166$i = 0, $parent179$i$i = 0, $parent196$i$i = 0;
 var $parent226$i = 0, $parent240$i = 0, $parent257$i = 0, $parent301$i$i = 0, $parent337$i$i = 0, $parent361$i$i = 0, $parent369$i = 0, $parent406$i = 0, $parent433$i = 0, $qsize$0$i$i = 0, $retval$0 = 0, $rsize$0$i = 0, $rsize$0$i162 = 0, $rsize$1$i = 0, $rsize$3$i = 0, $rsize$4$lcssa$i = 0, $rsize$418$i = 0, $rsize$418$i$ph = 0, $rst$0$i = 0, $rst$1$i = 0;
 var $sflags193$i = 0, $sflags235$i = 0, $shl = 0, $shl$i = 0, $shl$i$i = 0, $shl$i153 = 0, $shl102 = 0, $shl105 = 0, $shl116$i$i = 0, $shl12 = 0, $shl127$i$i = 0, $shl131$i$i = 0, $shl15$i = 0, $shl18$i = 0, $shl192$i = 0, $shl195$i = 0, $shl198$i = 0, $shl22 = 0, $shl222$i$i = 0, $shl226$i$i = 0;
 var $shl265$i$i = 0, $shl270$i$i = 0, $shl276$i$i = 0, $shl279$i$i = 0, $shl288$i = 0, $shl291$i = 0, $shl294$i$i = 0, $shl31$i = 0, $shl316$i$i = 0, $shl326$i$i = 0, $shl333$i = 0, $shl338$i = 0, $shl344$i = 0, $shl347$i = 0, $shl35 = 0, $shl362$i = 0, $shl37 = 0, $shl384$i = 0, $shl39$i$i = 0, $shl395$i = 0;
 var $shl48$i$i = 0, $shl60$i = 0, $shl65 = 0, $shl70$i$i = 0, $shl72 = 0, $shl75$i$i = 0, $shl81$i$i = 0, $shl84$i$i = 0, $shl9$i = 0, $shl90 = 0, $shl95$i$i = 0, $shr = 0, $shr$i = 0, $shr$i$i = 0, $shr$i148 = 0, $shr$i25$i = 0, $shr101 = 0, $shr11$i = 0, $shr11$i156 = 0, $shr110$i$i = 0;
 var $shr12$i = 0, $shr124$i$i = 0, $shr15$i = 0, $shr16$i = 0, $shr16$i157 = 0, $shr19$i = 0, $shr194$i = 0, $shr20$i = 0, $shr214$i$i = 0, $shr253$i$i = 0, $shr263$i$i = 0, $shr267$i$i = 0, $shr27$i = 0, $shr272$i$i = 0, $shr277$i$i = 0, $shr281$i$i = 0, $shr283$i = 0, $shr3 = 0, $shr310$i$i = 0, $shr318$i = 0;
 var $shr323$i$i = 0, $shr330$i = 0, $shr335$i = 0, $shr340$i = 0, $shr345$i = 0, $shr349$i = 0, $shr378$i = 0, $shr392$i = 0, $shr4$i = 0, $shr42$i = 0, $shr45 = 0, $shr47 = 0, $shr48 = 0, $shr5$i = 0, $shr5$i151 = 0, $shr51 = 0, $shr52 = 0, $shr55 = 0, $shr56 = 0, $shr58$i$i = 0;
 var $shr59 = 0, $shr60 = 0, $shr63 = 0, $shr68$i$i = 0, $shr7$i = 0, $shr7$i154 = 0, $shr72$i = 0, $shr72$i$i = 0, $shr75$i = 0, $shr76$i = 0, $shr77$i$i = 0, $shr79$i = 0, $shr8$i = 0, $shr80$i = 0, $shr82$i$i = 0, $shr83$i = 0, $shr84$i = 0, $shr86$i$i = 0, $shr87$i = 0, $shr88$i = 0;
 var $shr91$i = 0, $size$i$i = 0, $size$i$i$i = 0, $size$i$i$le = 0, $size188$i = 0, $size188$i$le = 0, $size245$i = 0, $sizebits$0$i = 0, $sp$0$i$i = 0, $sp$0$i$i$i = 0, $sp$0112$i = 0, $sp$1111$i = 0, $spec$select$i = 0, $spec$select$i171 = 0, $spec$select1$i = 0, $spec$select2$i = 0, $spec$select5$i = 0, $spec$select9$i = 0, $spec$select96$i = 0, $ssize$2$ph$i = 0;
 var $sub = 0, $sub$i = 0, $sub$i$i = 0, $sub$i$i$i = 0, $sub$i136 = 0, $sub$i147 = 0, $sub$i16$i = 0, $sub$i38$i = 0, $sub$i46$i = 0, $sub$ptr$lhs$cast$i = 0, $sub$ptr$lhs$cast$i$i = 0, $sub$ptr$lhs$cast$i19$i = 0, $sub$ptr$rhs$cast$i = 0, $sub$ptr$rhs$cast$i$i = 0, $sub$ptr$rhs$cast$i20$i = 0, $sub$ptr$sub$i = 0, $sub$ptr$sub$i$i = 0, $sub$ptr$sub$i21$i = 0, $sub10$i = 0, $sub101$i = 0;
 var $sub112$i = 0, $sub113$i$i = 0, $sub118$i = 0, $sub12$i$i = 0, $sub14$i = 0, $sub16$i$i = 0, $sub160 = 0, $sub172$i = 0, $sub18$i$i = 0, $sub190 = 0, $sub2$i = 0, $sub22$i = 0, $sub260$i = 0, $sub262$i$i = 0, $sub266$i$i = 0, $sub271$i$i = 0, $sub275$i$i = 0, $sub30$i = 0, $sub31$i = 0, $sub313$i$i = 0;
 var $sub329$i = 0, $sub33$i = 0, $sub334$i = 0, $sub339$i = 0, $sub343$i = 0, $sub381$i = 0, $sub4$i = 0, $sub41$i = 0, $sub42 = 0, $sub44 = 0, $sub5$i$i = 0, $sub5$i$i$i = 0, $sub5$i50$i = 0, $sub50$i = 0, $sub6$i = 0, $sub63$i = 0, $sub67$i = 0, $sub67$i$i = 0, $sub70$i = 0, $sub71$i$i = 0;
 var $sub76$i$i = 0, $sub80$i$i = 0, $sub91 = 0, $sub99$i = 0, $t$0$i = 0, $t$0$i161 = 0, $t$2$i = 0, $t$4$i = 0, $t$517$i = 0, $t$517$i$ph = 0, $tbase$795$i = 0, $tobool$i$i = 0, $tobool107 = 0, $tobool195$i = 0, $tobool200$i = 0, $tobool228$i$i = 0, $tobool237$i = 0, $tobool293$i = 0, $tobool296$i$i = 0, $tobool30$i = 0;
 var $tobool364$i = 0, $tobool97$i$i = 0, $tsize$2647482$i = 0, $tsize$4$i = 0, $tsize$794$i = 0, $v$0$i = 0, $v$0$i163 = 0, $v$1$i = 0, $v$3$i = 0, $v$3$i204 = 0, $v$4$lcssa$i = 0, $v$419$i = 0, $v$419$i$ph = 0, $xor$i$i = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $magic$i$i = sp;
 $cmp = ($bytes>>>0)<(245);
 do {
  if ($cmp) {
   $cmp1 = ($bytes>>>0)<(11);
   $add2 = (($bytes) + 11)|0;
   $and = $add2 & -8;
   $cond = $cmp1 ? 16 : $and;
   $shr = $cond >>> 3;
   $0 = HEAP32[556]|0;
   $shr3 = $0 >>> $shr;
   $and4 = $shr3 & 3;
   $cmp5 = ($and4|0)==(0);
   if (!($cmp5)) {
    $neg = $shr3 & 1;
    $and7 = $neg ^ 1;
    $add8 = (($and7) + ($shr))|0;
    $shl = $add8 << 1;
    $arrayidx = (2264 + ($shl<<2)|0);
    $1 = ((($arrayidx)) + 8|0);
    $2 = HEAP32[$1>>2]|0;
    $fd9 = ((($2)) + 8|0);
    $3 = HEAP32[$fd9>>2]|0;
    $cmp10 = ($3|0)==($arrayidx|0);
    if ($cmp10) {
     $shl12 = 1 << $add8;
     $neg13 = $shl12 ^ -1;
     $and14 = $0 & $neg13;
     HEAP32[556] = $and14;
    } else {
     $bk18 = ((($3)) + 12|0);
     HEAP32[$bk18>>2] = $arrayidx;
     HEAP32[$1>>2] = $3;
    }
    $shl22 = $add8 << 3;
    $or23 = $shl22 | 3;
    $head = ((($2)) + 4|0);
    HEAP32[$head>>2] = $or23;
    $add$ptr = (($2) + ($shl22)|0);
    $head25 = ((($add$ptr)) + 4|0);
    $4 = HEAP32[$head25>>2]|0;
    $or26 = $4 | 1;
    HEAP32[$head25>>2] = $or26;
    $retval$0 = $fd9;
    STACKTOP = sp;return ($retval$0|0);
   }
   $5 = HEAP32[(2232)>>2]|0;
   $cmp29 = ($cond>>>0)>($5>>>0);
   if ($cmp29) {
    $cmp31 = ($shr3|0)==(0);
    if (!($cmp31)) {
     $shl35 = $shr3 << $shr;
     $shl37 = 2 << $shr;
     $sub = (0 - ($shl37))|0;
     $or40 = $shl37 | $sub;
     $and41 = $shl35 & $or40;
     $sub42 = (0 - ($and41))|0;
     $and43 = $and41 & $sub42;
     $sub44 = (($and43) + -1)|0;
     $shr45 = $sub44 >>> 12;
     $and46 = $shr45 & 16;
     $shr47 = $sub44 >>> $and46;
     $shr48 = $shr47 >>> 5;
     $and49 = $shr48 & 8;
     $add50 = $and49 | $and46;
     $shr51 = $shr47 >>> $and49;
     $shr52 = $shr51 >>> 2;
     $and53 = $shr52 & 4;
     $add54 = $add50 | $and53;
     $shr55 = $shr51 >>> $and53;
     $shr56 = $shr55 >>> 1;
     $and57 = $shr56 & 2;
     $add58 = $add54 | $and57;
     $shr59 = $shr55 >>> $and57;
     $shr60 = $shr59 >>> 1;
     $and61 = $shr60 & 1;
     $add62 = $add58 | $and61;
     $shr63 = $shr59 >>> $and61;
     $add64 = (($add62) + ($shr63))|0;
     $shl65 = $add64 << 1;
     $arrayidx66 = (2264 + ($shl65<<2)|0);
     $6 = ((($arrayidx66)) + 8|0);
     $7 = HEAP32[$6>>2]|0;
     $fd69 = ((($7)) + 8|0);
     $8 = HEAP32[$fd69>>2]|0;
     $cmp70 = ($8|0)==($arrayidx66|0);
     if ($cmp70) {
      $shl72 = 1 << $add64;
      $neg73 = $shl72 ^ -1;
      $and74 = $0 & $neg73;
      HEAP32[556] = $and74;
      $10 = $and74;
     } else {
      $bk85 = ((($8)) + 12|0);
      HEAP32[$bk85>>2] = $arrayidx66;
      HEAP32[$6>>2] = $8;
      $10 = $0;
     }
     $shl90 = $add64 << 3;
     $sub91 = (($shl90) - ($cond))|0;
     $or93 = $cond | 3;
     $head94 = ((($7)) + 4|0);
     HEAP32[$head94>>2] = $or93;
     $add$ptr95 = (($7) + ($cond)|0);
     $or96 = $sub91 | 1;
     $head97 = ((($add$ptr95)) + 4|0);
     HEAP32[$head97>>2] = $or96;
     $add$ptr98 = (($7) + ($shl90)|0);
     HEAP32[$add$ptr98>>2] = $sub91;
     $cmp99 = ($5|0)==(0);
     if (!($cmp99)) {
      $9 = HEAP32[(2244)>>2]|0;
      $shr101 = $5 >>> 3;
      $shl102 = $shr101 << 1;
      $arrayidx103 = (2264 + ($shl102<<2)|0);
      $shl105 = 1 << $shr101;
      $and106 = $10 & $shl105;
      $tobool107 = ($and106|0)==(0);
      if ($tobool107) {
       $or110 = $10 | $shl105;
       HEAP32[556] = $or110;
       $$pre = ((($arrayidx103)) + 8|0);
       $$pre$phiZ2D = $$pre;$F104$0 = $arrayidx103;
      } else {
       $11 = ((($arrayidx103)) + 8|0);
       $12 = HEAP32[$11>>2]|0;
       $$pre$phiZ2D = $11;$F104$0 = $12;
      }
      HEAP32[$$pre$phiZ2D>>2] = $9;
      $bk122 = ((($F104$0)) + 12|0);
      HEAP32[$bk122>>2] = $9;
      $fd123 = ((($9)) + 8|0);
      HEAP32[$fd123>>2] = $F104$0;
      $bk124 = ((($9)) + 12|0);
      HEAP32[$bk124>>2] = $arrayidx103;
     }
     HEAP32[(2232)>>2] = $sub91;
     HEAP32[(2244)>>2] = $add$ptr95;
     $retval$0 = $fd69;
     STACKTOP = sp;return ($retval$0|0);
    }
    $13 = HEAP32[(2228)>>2]|0;
    $cmp128 = ($13|0)==(0);
    if ($cmp128) {
     $nb$0 = $cond;
    } else {
     $sub$i = (0 - ($13))|0;
     $and$i = $13 & $sub$i;
     $sub2$i = (($and$i) + -1)|0;
     $shr$i = $sub2$i >>> 12;
     $and3$i = $shr$i & 16;
     $shr4$i = $sub2$i >>> $and3$i;
     $shr5$i = $shr4$i >>> 5;
     $and6$i = $shr5$i & 8;
     $add$i = $and6$i | $and3$i;
     $shr7$i = $shr4$i >>> $and6$i;
     $shr8$i = $shr7$i >>> 2;
     $and9$i = $shr8$i & 4;
     $add10$i = $add$i | $and9$i;
     $shr11$i = $shr7$i >>> $and9$i;
     $shr12$i = $shr11$i >>> 1;
     $and13$i = $shr12$i & 2;
     $add14$i = $add10$i | $and13$i;
     $shr15$i = $shr11$i >>> $and13$i;
     $shr16$i = $shr15$i >>> 1;
     $and17$i = $shr16$i & 1;
     $add18$i = $add14$i | $and17$i;
     $shr19$i = $shr15$i >>> $and17$i;
     $add20$i = (($add18$i) + ($shr19$i))|0;
     $arrayidx$i = (2528 + ($add20$i<<2)|0);
     $14 = HEAP32[$arrayidx$i>>2]|0;
     $head$i = ((($14)) + 4|0);
     $15 = HEAP32[$head$i>>2]|0;
     $and21$i = $15 & -8;
     $sub22$i = (($and21$i) - ($cond))|0;
     $rsize$0$i = $sub22$i;$t$0$i = $14;$v$0$i = $14;
     while(1) {
      $arrayidx23$i = ((($t$0$i)) + 16|0);
      $16 = HEAP32[$arrayidx23$i>>2]|0;
      $cmp$i = ($16|0)==(0|0);
      if ($cmp$i) {
       $arrayidx27$i = ((($t$0$i)) + 20|0);
       $17 = HEAP32[$arrayidx27$i>>2]|0;
       $cmp28$i = ($17|0)==(0|0);
       if ($cmp28$i) {
        break;
       } else {
        $cond4$i = $17;
       }
      } else {
       $cond4$i = $16;
      }
      $head29$i = ((($cond4$i)) + 4|0);
      $18 = HEAP32[$head29$i>>2]|0;
      $and30$i = $18 & -8;
      $sub31$i = (($and30$i) - ($cond))|0;
      $cmp32$i = ($sub31$i>>>0)<($rsize$0$i>>>0);
      $spec$select$i = $cmp32$i ? $sub31$i : $rsize$0$i;
      $spec$select1$i = $cmp32$i ? $cond4$i : $v$0$i;
      $rsize$0$i = $spec$select$i;$t$0$i = $cond4$i;$v$0$i = $spec$select1$i;
     }
     $add$ptr$i = (($v$0$i) + ($cond)|0);
     $cmp35$i = ($add$ptr$i>>>0)>($v$0$i>>>0);
     if ($cmp35$i) {
      $parent$i = ((($v$0$i)) + 24|0);
      $19 = HEAP32[$parent$i>>2]|0;
      $bk$i = ((($v$0$i)) + 12|0);
      $20 = HEAP32[$bk$i>>2]|0;
      $cmp40$i = ($20|0)==($v$0$i|0);
      do {
       if ($cmp40$i) {
        $arrayidx61$i = ((($v$0$i)) + 20|0);
        $22 = HEAP32[$arrayidx61$i>>2]|0;
        $cmp62$i = ($22|0)==(0|0);
        if ($cmp62$i) {
         $arrayidx65$i = ((($v$0$i)) + 16|0);
         $23 = HEAP32[$arrayidx65$i>>2]|0;
         $cmp66$i = ($23|0)==(0|0);
         if ($cmp66$i) {
          $R$3$i = 0;
          break;
         } else {
          $R$1$i$ph = $23;$RP$1$i$ph = $arrayidx65$i;
         }
        } else {
         $R$1$i$ph = $22;$RP$1$i$ph = $arrayidx61$i;
        }
        $R$1$i = $R$1$i$ph;$RP$1$i = $RP$1$i$ph;
        while(1) {
         $arrayidx71$i = ((($R$1$i)) + 20|0);
         $24 = HEAP32[$arrayidx71$i>>2]|0;
         $cmp72$i = ($24|0)==(0|0);
         if ($cmp72$i) {
          $arrayidx75$i = ((($R$1$i)) + 16|0);
          $25 = HEAP32[$arrayidx75$i>>2]|0;
          $cmp76$i = ($25|0)==(0|0);
          if ($cmp76$i) {
           break;
          } else {
           $R$1$i$be = $25;$RP$1$i$be = $arrayidx75$i;
          }
         } else {
          $R$1$i$be = $24;$RP$1$i$be = $arrayidx71$i;
         }
         $R$1$i = $R$1$i$be;$RP$1$i = $RP$1$i$be;
        }
        HEAP32[$RP$1$i>>2] = 0;
        $R$3$i = $R$1$i;
       } else {
        $fd$i = ((($v$0$i)) + 8|0);
        $21 = HEAP32[$fd$i>>2]|0;
        $bk56$i = ((($21)) + 12|0);
        HEAP32[$bk56$i>>2] = $20;
        $fd57$i = ((($20)) + 8|0);
        HEAP32[$fd57$i>>2] = $21;
        $R$3$i = $20;
       }
      } while(0);
      $cmp90$i = ($19|0)==(0|0);
      do {
       if (!($cmp90$i)) {
        $index$i = ((($v$0$i)) + 28|0);
        $26 = HEAP32[$index$i>>2]|0;
        $arrayidx94$i = (2528 + ($26<<2)|0);
        $27 = HEAP32[$arrayidx94$i>>2]|0;
        $cmp95$i = ($v$0$i|0)==($27|0);
        if ($cmp95$i) {
         HEAP32[$arrayidx94$i>>2] = $R$3$i;
         $cond2$i = ($R$3$i|0)==(0|0);
         if ($cond2$i) {
          $shl$i = 1 << $26;
          $neg$i = $shl$i ^ -1;
          $and103$i = $13 & $neg$i;
          HEAP32[(2228)>>2] = $and103$i;
          break;
         }
        } else {
         $arrayidx113$i = ((($19)) + 16|0);
         $28 = HEAP32[$arrayidx113$i>>2]|0;
         $cmp114$i = ($28|0)==($v$0$i|0);
         $arrayidx121$i = ((($19)) + 20|0);
         $arrayidx121$i$sink = $cmp114$i ? $arrayidx113$i : $arrayidx121$i;
         HEAP32[$arrayidx121$i$sink>>2] = $R$3$i;
         $cmp126$i = ($R$3$i|0)==(0|0);
         if ($cmp126$i) {
          break;
         }
        }
        $parent135$i = ((($R$3$i)) + 24|0);
        HEAP32[$parent135$i>>2] = $19;
        $arrayidx137$i = ((($v$0$i)) + 16|0);
        $29 = HEAP32[$arrayidx137$i>>2]|0;
        $cmp138$i = ($29|0)==(0|0);
        if (!($cmp138$i)) {
         $arrayidx148$i = ((($R$3$i)) + 16|0);
         HEAP32[$arrayidx148$i>>2] = $29;
         $parent149$i = ((($29)) + 24|0);
         HEAP32[$parent149$i>>2] = $R$3$i;
        }
        $arrayidx154$i = ((($v$0$i)) + 20|0);
        $30 = HEAP32[$arrayidx154$i>>2]|0;
        $cmp155$i = ($30|0)==(0|0);
        if (!($cmp155$i)) {
         $arrayidx165$i = ((($R$3$i)) + 20|0);
         HEAP32[$arrayidx165$i>>2] = $30;
         $parent166$i = ((($30)) + 24|0);
         HEAP32[$parent166$i>>2] = $R$3$i;
        }
       }
      } while(0);
      $cmp174$i = ($rsize$0$i>>>0)<(16);
      if ($cmp174$i) {
       $add177$i = (($rsize$0$i) + ($cond))|0;
       $or178$i = $add177$i | 3;
       $head179$i = ((($v$0$i)) + 4|0);
       HEAP32[$head179$i>>2] = $or178$i;
       $add$ptr181$i = (($v$0$i) + ($add177$i)|0);
       $head182$i = ((($add$ptr181$i)) + 4|0);
       $31 = HEAP32[$head182$i>>2]|0;
       $or183$i = $31 | 1;
       HEAP32[$head182$i>>2] = $or183$i;
      } else {
       $or186$i = $cond | 3;
       $head187$i = ((($v$0$i)) + 4|0);
       HEAP32[$head187$i>>2] = $or186$i;
       $or188$i = $rsize$0$i | 1;
       $head189$i = ((($add$ptr$i)) + 4|0);
       HEAP32[$head189$i>>2] = $or188$i;
       $add$ptr190$i = (($add$ptr$i) + ($rsize$0$i)|0);
       HEAP32[$add$ptr190$i>>2] = $rsize$0$i;
       $cmp191$i = ($5|0)==(0);
       if (!($cmp191$i)) {
        $32 = HEAP32[(2244)>>2]|0;
        $shr194$i = $5 >>> 3;
        $shl195$i = $shr194$i << 1;
        $arrayidx196$i = (2264 + ($shl195$i<<2)|0);
        $shl198$i = 1 << $shr194$i;
        $and199$i = $shl198$i & $0;
        $tobool200$i = ($and199$i|0)==(0);
        if ($tobool200$i) {
         $or204$i = $shl198$i | $0;
         HEAP32[556] = $or204$i;
         $$pre$i = ((($arrayidx196$i)) + 8|0);
         $$pre$phi$iZ2D = $$pre$i;$F197$0$i = $arrayidx196$i;
        } else {
         $33 = ((($arrayidx196$i)) + 8|0);
         $34 = HEAP32[$33>>2]|0;
         $$pre$phi$iZ2D = $33;$F197$0$i = $34;
        }
        HEAP32[$$pre$phi$iZ2D>>2] = $32;
        $bk218$i = ((($F197$0$i)) + 12|0);
        HEAP32[$bk218$i>>2] = $32;
        $fd219$i = ((($32)) + 8|0);
        HEAP32[$fd219$i>>2] = $F197$0$i;
        $bk220$i = ((($32)) + 12|0);
        HEAP32[$bk220$i>>2] = $arrayidx196$i;
       }
       HEAP32[(2232)>>2] = $rsize$0$i;
       HEAP32[(2244)>>2] = $add$ptr$i;
      }
      $add$ptr225$i = ((($v$0$i)) + 8|0);
      $retval$0 = $add$ptr225$i;
      STACKTOP = sp;return ($retval$0|0);
     } else {
      $nb$0 = $cond;
     }
    }
   } else {
    $nb$0 = $cond;
   }
  } else {
   $cmp139 = ($bytes>>>0)>(4294967231);
   if ($cmp139) {
    $nb$0 = -1;
   } else {
    $add144 = (($bytes) + 11)|0;
    $and145 = $add144 & -8;
    $35 = HEAP32[(2228)>>2]|0;
    $cmp146 = ($35|0)==(0);
    if ($cmp146) {
     $nb$0 = $and145;
    } else {
     $sub$i147 = (0 - ($and145))|0;
     $shr$i148 = $add144 >>> 8;
     $cmp$i149 = ($shr$i148|0)==(0);
     if ($cmp$i149) {
      $idx$0$i = 0;
     } else {
      $cmp1$i = ($and145>>>0)>(16777215);
      if ($cmp1$i) {
       $idx$0$i = 31;
      } else {
       $sub4$i = (($shr$i148) + 1048320)|0;
       $shr5$i151 = $sub4$i >>> 16;
       $and$i152 = $shr5$i151 & 8;
       $shl$i153 = $shr$i148 << $and$i152;
       $sub6$i = (($shl$i153) + 520192)|0;
       $shr7$i154 = $sub6$i >>> 16;
       $and8$i = $shr7$i154 & 4;
       $add$i155 = $and8$i | $and$i152;
       $shl9$i = $shl$i153 << $and8$i;
       $sub10$i = (($shl9$i) + 245760)|0;
       $shr11$i156 = $sub10$i >>> 16;
       $and12$i = $shr11$i156 & 2;
       $add13$i = $add$i155 | $and12$i;
       $sub14$i = (14 - ($add13$i))|0;
       $shl15$i = $shl9$i << $and12$i;
       $shr16$i157 = $shl15$i >>> 15;
       $add17$i158 = (($sub14$i) + ($shr16$i157))|0;
       $shl18$i = $add17$i158 << 1;
       $add19$i = (($add17$i158) + 7)|0;
       $shr20$i = $and145 >>> $add19$i;
       $and21$i159 = $shr20$i & 1;
       $add22$i = $and21$i159 | $shl18$i;
       $idx$0$i = $add22$i;
      }
     }
     $arrayidx$i160 = (2528 + ($idx$0$i<<2)|0);
     $36 = HEAP32[$arrayidx$i160>>2]|0;
     $cmp24$i = ($36|0)==(0|0);
     L79: do {
      if ($cmp24$i) {
       $rsize$3$i = $sub$i147;$t$2$i = 0;$v$3$i = 0;
       label = 61;
      } else {
       $cmp26$i = ($idx$0$i|0)==(31);
       $shr27$i = $idx$0$i >>> 1;
       $sub30$i = (25 - ($shr27$i))|0;
       $cond$i = $cmp26$i ? 0 : $sub30$i;
       $shl31$i = $and145 << $cond$i;
       $rsize$0$i162 = $sub$i147;$rst$0$i = 0;$sizebits$0$i = $shl31$i;$t$0$i161 = $36;$v$0$i163 = 0;
       while(1) {
        $head$i164 = ((($t$0$i161)) + 4|0);
        $37 = HEAP32[$head$i164>>2]|0;
        $and32$i = $37 & -8;
        $sub33$i = (($and32$i) - ($and145))|0;
        $cmp34$i = ($sub33$i>>>0)<($rsize$0$i162>>>0);
        if ($cmp34$i) {
         $cmp36$i = ($sub33$i|0)==(0);
         if ($cmp36$i) {
          $rsize$418$i$ph = 0;$t$517$i$ph = $t$0$i161;$v$419$i$ph = $t$0$i161;
          label = 65;
          break L79;
         } else {
          $rsize$1$i = $sub33$i;$v$1$i = $t$0$i161;
         }
        } else {
         $rsize$1$i = $rsize$0$i162;$v$1$i = $v$0$i163;
        }
        $arrayidx40$i = ((($t$0$i161)) + 20|0);
        $38 = HEAP32[$arrayidx40$i>>2]|0;
        $shr42$i = $sizebits$0$i >>> 31;
        $arrayidx44$i = (((($t$0$i161)) + 16|0) + ($shr42$i<<2)|0);
        $39 = HEAP32[$arrayidx44$i>>2]|0;
        $cmp45$i = ($38|0)==(0|0);
        $cmp46$i = ($38|0)==($39|0);
        $or$cond1$i165 = $cmp45$i | $cmp46$i;
        $rst$1$i = $or$cond1$i165 ? $rst$0$i : $38;
        $cmp49$i = ($39|0)==(0|0);
        $spec$select5$i = $sizebits$0$i << 1;
        if ($cmp49$i) {
         $rsize$3$i = $rsize$1$i;$t$2$i = $rst$1$i;$v$3$i = $v$1$i;
         label = 61;
         break;
        } else {
         $rsize$0$i162 = $rsize$1$i;$rst$0$i = $rst$1$i;$sizebits$0$i = $spec$select5$i;$t$0$i161 = $39;$v$0$i163 = $v$1$i;
        }
       }
      }
     } while(0);
     if ((label|0) == 61) {
      $cmp55$i166 = ($t$2$i|0)==(0|0);
      $cmp57$i167 = ($v$3$i|0)==(0|0);
      $or$cond$i168 = $cmp55$i166 & $cmp57$i167;
      if ($or$cond$i168) {
       $shl60$i = 2 << $idx$0$i;
       $sub63$i = (0 - ($shl60$i))|0;
       $or$i169 = $shl60$i | $sub63$i;
       $and64$i = $or$i169 & $35;
       $cmp65$i = ($and64$i|0)==(0);
       if ($cmp65$i) {
        $nb$0 = $and145;
        break;
       }
       $sub67$i = (0 - ($and64$i))|0;
       $and68$i = $and64$i & $sub67$i;
       $sub70$i = (($and68$i) + -1)|0;
       $shr72$i = $sub70$i >>> 12;
       $and73$i = $shr72$i & 16;
       $shr75$i = $sub70$i >>> $and73$i;
       $shr76$i = $shr75$i >>> 5;
       $and77$i = $shr76$i & 8;
       $add78$i = $and77$i | $and73$i;
       $shr79$i = $shr75$i >>> $and77$i;
       $shr80$i = $shr79$i >>> 2;
       $and81$i = $shr80$i & 4;
       $add82$i = $add78$i | $and81$i;
       $shr83$i = $shr79$i >>> $and81$i;
       $shr84$i = $shr83$i >>> 1;
       $and85$i = $shr84$i & 2;
       $add86$i = $add82$i | $and85$i;
       $shr87$i = $shr83$i >>> $and85$i;
       $shr88$i = $shr87$i >>> 1;
       $and89$i = $shr88$i & 1;
       $add90$i = $add86$i | $and89$i;
       $shr91$i = $shr87$i >>> $and89$i;
       $add92$i = (($add90$i) + ($shr91$i))|0;
       $arrayidx94$i170 = (2528 + ($add92$i<<2)|0);
       $40 = HEAP32[$arrayidx94$i170>>2]|0;
       $t$4$i = $40;$v$3$i204 = 0;
      } else {
       $t$4$i = $t$2$i;$v$3$i204 = $v$3$i;
      }
      $cmp9716$i = ($t$4$i|0)==(0|0);
      if ($cmp9716$i) {
       $rsize$4$lcssa$i = $rsize$3$i;$v$4$lcssa$i = $v$3$i204;
      } else {
       $rsize$418$i$ph = $rsize$3$i;$t$517$i$ph = $t$4$i;$v$419$i$ph = $v$3$i204;
       label = 65;
      }
     }
     if ((label|0) == 65) {
      $rsize$418$i = $rsize$418$i$ph;$t$517$i = $t$517$i$ph;$v$419$i = $v$419$i$ph;
      while(1) {
       $head99$i = ((($t$517$i)) + 4|0);
       $41 = HEAP32[$head99$i>>2]|0;
       $and100$i = $41 & -8;
       $sub101$i = (($and100$i) - ($and145))|0;
       $cmp102$i = ($sub101$i>>>0)<($rsize$418$i>>>0);
       $spec$select$i171 = $cmp102$i ? $sub101$i : $rsize$418$i;
       $spec$select2$i = $cmp102$i ? $t$517$i : $v$419$i;
       $arrayidx106$i = ((($t$517$i)) + 16|0);
       $42 = HEAP32[$arrayidx106$i>>2]|0;
       $cmp107$i = ($42|0)==(0|0);
       if ($cmp107$i) {
        $arrayidx113$i173 = ((($t$517$i)) + 20|0);
        $43 = HEAP32[$arrayidx113$i173>>2]|0;
        $cond115$i = $43;
       } else {
        $cond115$i = $42;
       }
       $cmp97$i = ($cond115$i|0)==(0|0);
       if ($cmp97$i) {
        $rsize$4$lcssa$i = $spec$select$i171;$v$4$lcssa$i = $spec$select2$i;
        break;
       } else {
        $rsize$418$i = $spec$select$i171;$t$517$i = $cond115$i;$v$419$i = $spec$select2$i;
       }
      }
     }
     $cmp116$i = ($v$4$lcssa$i|0)==(0|0);
     if ($cmp116$i) {
      $nb$0 = $and145;
     } else {
      $44 = HEAP32[(2232)>>2]|0;
      $sub118$i = (($44) - ($and145))|0;
      $cmp119$i = ($rsize$4$lcssa$i>>>0)<($sub118$i>>>0);
      if ($cmp119$i) {
       $add$ptr$i174 = (($v$4$lcssa$i) + ($and145)|0);
       $cmp123$i = ($add$ptr$i174>>>0)>($v$4$lcssa$i>>>0);
       if ($cmp123$i) {
        $parent$i175 = ((($v$4$lcssa$i)) + 24|0);
        $45 = HEAP32[$parent$i175>>2]|0;
        $bk$i176 = ((($v$4$lcssa$i)) + 12|0);
        $46 = HEAP32[$bk$i176>>2]|0;
        $cmp128$i = ($46|0)==($v$4$lcssa$i|0);
        do {
         if ($cmp128$i) {
          $arrayidx151$i = ((($v$4$lcssa$i)) + 20|0);
          $48 = HEAP32[$arrayidx151$i>>2]|0;
          $cmp152$i = ($48|0)==(0|0);
          if ($cmp152$i) {
           $arrayidx155$i = ((($v$4$lcssa$i)) + 16|0);
           $49 = HEAP32[$arrayidx155$i>>2]|0;
           $cmp156$i = ($49|0)==(0|0);
           if ($cmp156$i) {
            $R$3$i188 = 0;
            break;
           } else {
            $R$1$i183$ph = $49;$RP$1$i182$ph = $arrayidx155$i;
           }
          } else {
           $R$1$i183$ph = $48;$RP$1$i182$ph = $arrayidx151$i;
          }
          $R$1$i183 = $R$1$i183$ph;$RP$1$i182 = $RP$1$i182$ph;
          while(1) {
           $arrayidx161$i = ((($R$1$i183)) + 20|0);
           $50 = HEAP32[$arrayidx161$i>>2]|0;
           $cmp162$i184 = ($50|0)==(0|0);
           if ($cmp162$i184) {
            $arrayidx165$i185 = ((($R$1$i183)) + 16|0);
            $51 = HEAP32[$arrayidx165$i185>>2]|0;
            $cmp166$i = ($51|0)==(0|0);
            if ($cmp166$i) {
             break;
            } else {
             $R$1$i183$be = $51;$RP$1$i182$be = $arrayidx165$i185;
            }
           } else {
            $R$1$i183$be = $50;$RP$1$i182$be = $arrayidx161$i;
           }
           $R$1$i183 = $R$1$i183$be;$RP$1$i182 = $RP$1$i182$be;
          }
          HEAP32[$RP$1$i182>>2] = 0;
          $R$3$i188 = $R$1$i183;
         } else {
          $fd$i177 = ((($v$4$lcssa$i)) + 8|0);
          $47 = HEAP32[$fd$i177>>2]|0;
          $bk145$i = ((($47)) + 12|0);
          HEAP32[$bk145$i>>2] = $46;
          $fd146$i = ((($46)) + 8|0);
          HEAP32[$fd146$i>>2] = $47;
          $R$3$i188 = $46;
         }
        } while(0);
        $cmp180$i = ($45|0)==(0|0);
        do {
         if ($cmp180$i) {
          $61 = $35;
         } else {
          $index$i189 = ((($v$4$lcssa$i)) + 28|0);
          $52 = HEAP32[$index$i189>>2]|0;
          $arrayidx184$i = (2528 + ($52<<2)|0);
          $53 = HEAP32[$arrayidx184$i>>2]|0;
          $cmp185$i = ($v$4$lcssa$i|0)==($53|0);
          if ($cmp185$i) {
           HEAP32[$arrayidx184$i>>2] = $R$3$i188;
           $cond3$i = ($R$3$i188|0)==(0|0);
           if ($cond3$i) {
            $shl192$i = 1 << $52;
            $neg$i190 = $shl192$i ^ -1;
            $and194$i191 = $35 & $neg$i190;
            HEAP32[(2228)>>2] = $and194$i191;
            $61 = $and194$i191;
            break;
           }
          } else {
           $arrayidx204$i = ((($45)) + 16|0);
           $54 = HEAP32[$arrayidx204$i>>2]|0;
           $cmp205$i = ($54|0)==($v$4$lcssa$i|0);
           $arrayidx212$i = ((($45)) + 20|0);
           $arrayidx212$i$sink = $cmp205$i ? $arrayidx204$i : $arrayidx212$i;
           HEAP32[$arrayidx212$i$sink>>2] = $R$3$i188;
           $cmp217$i = ($R$3$i188|0)==(0|0);
           if ($cmp217$i) {
            $61 = $35;
            break;
           }
          }
          $parent226$i = ((($R$3$i188)) + 24|0);
          HEAP32[$parent226$i>>2] = $45;
          $arrayidx228$i = ((($v$4$lcssa$i)) + 16|0);
          $55 = HEAP32[$arrayidx228$i>>2]|0;
          $cmp229$i = ($55|0)==(0|0);
          if (!($cmp229$i)) {
           $arrayidx239$i = ((($R$3$i188)) + 16|0);
           HEAP32[$arrayidx239$i>>2] = $55;
           $parent240$i = ((($55)) + 24|0);
           HEAP32[$parent240$i>>2] = $R$3$i188;
          }
          $arrayidx245$i = ((($v$4$lcssa$i)) + 20|0);
          $56 = HEAP32[$arrayidx245$i>>2]|0;
          $cmp246$i = ($56|0)==(0|0);
          if ($cmp246$i) {
           $61 = $35;
          } else {
           $arrayidx256$i = ((($R$3$i188)) + 20|0);
           HEAP32[$arrayidx256$i>>2] = $56;
           $parent257$i = ((($56)) + 24|0);
           HEAP32[$parent257$i>>2] = $R$3$i188;
           $61 = $35;
          }
         }
        } while(0);
        $cmp265$i = ($rsize$4$lcssa$i>>>0)<(16);
        L128: do {
         if ($cmp265$i) {
          $add268$i = (($rsize$4$lcssa$i) + ($and145))|0;
          $or270$i = $add268$i | 3;
          $head271$i = ((($v$4$lcssa$i)) + 4|0);
          HEAP32[$head271$i>>2] = $or270$i;
          $add$ptr273$i = (($v$4$lcssa$i) + ($add268$i)|0);
          $head274$i = ((($add$ptr273$i)) + 4|0);
          $57 = HEAP32[$head274$i>>2]|0;
          $or275$i = $57 | 1;
          HEAP32[$head274$i>>2] = $or275$i;
         } else {
          $or278$i = $and145 | 3;
          $head279$i = ((($v$4$lcssa$i)) + 4|0);
          HEAP32[$head279$i>>2] = $or278$i;
          $or280$i = $rsize$4$lcssa$i | 1;
          $head281$i = ((($add$ptr$i174)) + 4|0);
          HEAP32[$head281$i>>2] = $or280$i;
          $add$ptr282$i = (($add$ptr$i174) + ($rsize$4$lcssa$i)|0);
          HEAP32[$add$ptr282$i>>2] = $rsize$4$lcssa$i;
          $shr283$i = $rsize$4$lcssa$i >>> 3;
          $cmp284$i = ($rsize$4$lcssa$i>>>0)<(256);
          if ($cmp284$i) {
           $shl288$i = $shr283$i << 1;
           $arrayidx289$i = (2264 + ($shl288$i<<2)|0);
           $58 = HEAP32[556]|0;
           $shl291$i = 1 << $shr283$i;
           $and292$i = $58 & $shl291$i;
           $tobool293$i = ($and292$i|0)==(0);
           if ($tobool293$i) {
            $or297$i = $58 | $shl291$i;
            HEAP32[556] = $or297$i;
            $$pre$i194 = ((($arrayidx289$i)) + 8|0);
            $$pre$phi$i195Z2D = $$pre$i194;$F290$0$i = $arrayidx289$i;
           } else {
            $59 = ((($arrayidx289$i)) + 8|0);
            $60 = HEAP32[$59>>2]|0;
            $$pre$phi$i195Z2D = $59;$F290$0$i = $60;
           }
           HEAP32[$$pre$phi$i195Z2D>>2] = $add$ptr$i174;
           $bk311$i = ((($F290$0$i)) + 12|0);
           HEAP32[$bk311$i>>2] = $add$ptr$i174;
           $fd312$i = ((($add$ptr$i174)) + 8|0);
           HEAP32[$fd312$i>>2] = $F290$0$i;
           $bk313$i = ((($add$ptr$i174)) + 12|0);
           HEAP32[$bk313$i>>2] = $arrayidx289$i;
           break;
          }
          $shr318$i = $rsize$4$lcssa$i >>> 8;
          $cmp319$i = ($shr318$i|0)==(0);
          if ($cmp319$i) {
           $I316$0$i = 0;
          } else {
           $cmp323$i = ($rsize$4$lcssa$i>>>0)>(16777215);
           if ($cmp323$i) {
            $I316$0$i = 31;
           } else {
            $sub329$i = (($shr318$i) + 1048320)|0;
            $shr330$i = $sub329$i >>> 16;
            $and331$i = $shr330$i & 8;
            $shl333$i = $shr318$i << $and331$i;
            $sub334$i = (($shl333$i) + 520192)|0;
            $shr335$i = $sub334$i >>> 16;
            $and336$i = $shr335$i & 4;
            $add337$i = $and336$i | $and331$i;
            $shl338$i = $shl333$i << $and336$i;
            $sub339$i = (($shl338$i) + 245760)|0;
            $shr340$i = $sub339$i >>> 16;
            $and341$i = $shr340$i & 2;
            $add342$i = $add337$i | $and341$i;
            $sub343$i = (14 - ($add342$i))|0;
            $shl344$i = $shl338$i << $and341$i;
            $shr345$i = $shl344$i >>> 15;
            $add346$i = (($sub343$i) + ($shr345$i))|0;
            $shl347$i = $add346$i << 1;
            $add348$i = (($add346$i) + 7)|0;
            $shr349$i = $rsize$4$lcssa$i >>> $add348$i;
            $and350$i = $shr349$i & 1;
            $add351$i = $and350$i | $shl347$i;
            $I316$0$i = $add351$i;
           }
          }
          $arrayidx355$i = (2528 + ($I316$0$i<<2)|0);
          $index356$i = ((($add$ptr$i174)) + 28|0);
          HEAP32[$index356$i>>2] = $I316$0$i;
          $child357$i = ((($add$ptr$i174)) + 16|0);
          $arrayidx358$i = ((($child357$i)) + 4|0);
          HEAP32[$arrayidx358$i>>2] = 0;
          HEAP32[$child357$i>>2] = 0;
          $shl362$i = 1 << $I316$0$i;
          $and363$i = $61 & $shl362$i;
          $tobool364$i = ($and363$i|0)==(0);
          if ($tobool364$i) {
           $or368$i = $61 | $shl362$i;
           HEAP32[(2228)>>2] = $or368$i;
           HEAP32[$arrayidx355$i>>2] = $add$ptr$i174;
           $parent369$i = ((($add$ptr$i174)) + 24|0);
           HEAP32[$parent369$i>>2] = $arrayidx355$i;
           $bk370$i = ((($add$ptr$i174)) + 12|0);
           HEAP32[$bk370$i>>2] = $add$ptr$i174;
           $fd371$i = ((($add$ptr$i174)) + 8|0);
           HEAP32[$fd371$i>>2] = $add$ptr$i174;
           break;
          }
          $62 = HEAP32[$arrayidx355$i>>2]|0;
          $head38611$i = ((($62)) + 4|0);
          $63 = HEAP32[$head38611$i>>2]|0;
          $and38712$i = $63 & -8;
          $cmp38813$i = ($and38712$i|0)==($rsize$4$lcssa$i|0);
          L145: do {
           if ($cmp38813$i) {
            $T$0$lcssa$i = $62;
           } else {
            $cmp374$i = ($I316$0$i|0)==(31);
            $shr378$i = $I316$0$i >>> 1;
            $sub381$i = (25 - ($shr378$i))|0;
            $cond383$i = $cmp374$i ? 0 : $sub381$i;
            $shl384$i = $rsize$4$lcssa$i << $cond383$i;
            $K373$015$i = $shl384$i;$T$014$i = $62;
            while(1) {
             $shr392$i = $K373$015$i >>> 31;
             $arrayidx394$i = (((($T$014$i)) + 16|0) + ($shr392$i<<2)|0);
             $64 = HEAP32[$arrayidx394$i>>2]|0;
             $cmp396$i = ($64|0)==(0|0);
             if ($cmp396$i) {
              break;
             }
             $shl395$i = $K373$015$i << 1;
             $head386$i = ((($64)) + 4|0);
             $65 = HEAP32[$head386$i>>2]|0;
             $and387$i = $65 & -8;
             $cmp388$i = ($and387$i|0)==($rsize$4$lcssa$i|0);
             if ($cmp388$i) {
              $T$0$lcssa$i = $64;
              break L145;
             } else {
              $K373$015$i = $shl395$i;$T$014$i = $64;
             }
            }
            HEAP32[$arrayidx394$i>>2] = $add$ptr$i174;
            $parent406$i = ((($add$ptr$i174)) + 24|0);
            HEAP32[$parent406$i>>2] = $T$014$i;
            $bk407$i = ((($add$ptr$i174)) + 12|0);
            HEAP32[$bk407$i>>2] = $add$ptr$i174;
            $fd408$i = ((($add$ptr$i174)) + 8|0);
            HEAP32[$fd408$i>>2] = $add$ptr$i174;
            break L128;
           }
          } while(0);
          $fd416$i = ((($T$0$lcssa$i)) + 8|0);
          $66 = HEAP32[$fd416$i>>2]|0;
          $bk429$i = ((($66)) + 12|0);
          HEAP32[$bk429$i>>2] = $add$ptr$i174;
          HEAP32[$fd416$i>>2] = $add$ptr$i174;
          $fd431$i = ((($add$ptr$i174)) + 8|0);
          HEAP32[$fd431$i>>2] = $66;
          $bk432$i = ((($add$ptr$i174)) + 12|0);
          HEAP32[$bk432$i>>2] = $T$0$lcssa$i;
          $parent433$i = ((($add$ptr$i174)) + 24|0);
          HEAP32[$parent433$i>>2] = 0;
         }
        } while(0);
        $add$ptr441$i = ((($v$4$lcssa$i)) + 8|0);
        $retval$0 = $add$ptr441$i;
        STACKTOP = sp;return ($retval$0|0);
       } else {
        $nb$0 = $and145;
       }
      } else {
       $nb$0 = $and145;
      }
     }
    }
   }
  }
 } while(0);
 $67 = HEAP32[(2232)>>2]|0;
 $cmp156 = ($67>>>0)<($nb$0>>>0);
 if (!($cmp156)) {
  $sub160 = (($67) - ($nb$0))|0;
  $68 = HEAP32[(2244)>>2]|0;
  $cmp162 = ($sub160>>>0)>(15);
  if ($cmp162) {
   $add$ptr166 = (($68) + ($nb$0)|0);
   HEAP32[(2244)>>2] = $add$ptr166;
   HEAP32[(2232)>>2] = $sub160;
   $or167 = $sub160 | 1;
   $head168 = ((($add$ptr166)) + 4|0);
   HEAP32[$head168>>2] = $or167;
   $add$ptr169 = (($68) + ($67)|0);
   HEAP32[$add$ptr169>>2] = $sub160;
   $or172 = $nb$0 | 3;
   $head173 = ((($68)) + 4|0);
   HEAP32[$head173>>2] = $or172;
  } else {
   HEAP32[(2232)>>2] = 0;
   HEAP32[(2244)>>2] = 0;
   $or176 = $67 | 3;
   $head177 = ((($68)) + 4|0);
   HEAP32[$head177>>2] = $or176;
   $add$ptr178 = (($68) + ($67)|0);
   $head179 = ((($add$ptr178)) + 4|0);
   $69 = HEAP32[$head179>>2]|0;
   $or180 = $69 | 1;
   HEAP32[$head179>>2] = $or180;
  }
  $add$ptr182 = ((($68)) + 8|0);
  $retval$0 = $add$ptr182;
  STACKTOP = sp;return ($retval$0|0);
 }
 $70 = HEAP32[(2236)>>2]|0;
 $cmp186 = ($70>>>0)>($nb$0>>>0);
 if ($cmp186) {
  $sub190 = (($70) - ($nb$0))|0;
  HEAP32[(2236)>>2] = $sub190;
  $71 = HEAP32[(2248)>>2]|0;
  $add$ptr193 = (($71) + ($nb$0)|0);
  HEAP32[(2248)>>2] = $add$ptr193;
  $or194 = $sub190 | 1;
  $head195 = ((($add$ptr193)) + 4|0);
  HEAP32[$head195>>2] = $or194;
  $or197 = $nb$0 | 3;
  $head198 = ((($71)) + 4|0);
  HEAP32[$head198>>2] = $or197;
  $add$ptr199 = ((($71)) + 8|0);
  $retval$0 = $add$ptr199;
  STACKTOP = sp;return ($retval$0|0);
 }
 $72 = HEAP32[674]|0;
 $cmp$i133 = ($72|0)==(0);
 if ($cmp$i133) {
  HEAP32[(2704)>>2] = 4096;
  HEAP32[(2700)>>2] = 4096;
  HEAP32[(2708)>>2] = -1;
  HEAP32[(2712)>>2] = -1;
  HEAP32[(2716)>>2] = 0;
  HEAP32[(2668)>>2] = 0;
  $73 = $magic$i$i;
  $xor$i$i = $73 & -16;
  $and6$i$i = $xor$i$i ^ 1431655768;
  HEAP32[674] = $and6$i$i;
  $74 = 4096;
 } else {
  $$pre$i134 = HEAP32[(2704)>>2]|0;
  $74 = $$pre$i134;
 }
 $add$i135 = (($nb$0) + 48)|0;
 $sub$i136 = (($nb$0) + 47)|0;
 $add9$i = (($74) + ($sub$i136))|0;
 $neg$i137 = (0 - ($74))|0;
 $and11$i = $add9$i & $neg$i137;
 $cmp12$i = ($and11$i>>>0)>($nb$0>>>0);
 if (!($cmp12$i)) {
  $retval$0 = 0;
  STACKTOP = sp;return ($retval$0|0);
 }
 $75 = HEAP32[(2664)>>2]|0;
 $cmp15$i = ($75|0)==(0);
 if (!($cmp15$i)) {
  $76 = HEAP32[(2656)>>2]|0;
  $add17$i = (($76) + ($and11$i))|0;
  $cmp19$i = ($add17$i>>>0)<=($76>>>0);
  $cmp21$i = ($add17$i>>>0)>($75>>>0);
  $or$cond1$i = $cmp19$i | $cmp21$i;
  if ($or$cond1$i) {
   $retval$0 = 0;
   STACKTOP = sp;return ($retval$0|0);
  }
 }
 $77 = HEAP32[(2668)>>2]|0;
 $and29$i = $77 & 4;
 $tobool30$i = ($and29$i|0)==(0);
 L178: do {
  if ($tobool30$i) {
   $78 = HEAP32[(2248)>>2]|0;
   $cmp32$i138 = ($78|0)==(0|0);
   L180: do {
    if ($cmp32$i138) {
     label = 128;
    } else {
     $sp$0$i$i = (2672);
     while(1) {
      $79 = HEAP32[$sp$0$i$i>>2]|0;
      $cmp$i55$i = ($79>>>0)>($78>>>0);
      if (!($cmp$i55$i)) {
       $size$i$i = ((($sp$0$i$i)) + 4|0);
       $80 = HEAP32[$size$i$i>>2]|0;
       $add$ptr$i57$i = (($79) + ($80)|0);
       $cmp2$i$i = ($add$ptr$i57$i>>>0)>($78>>>0);
       if ($cmp2$i$i) {
        break;
       }
      }
      $next$i$i = ((($sp$0$i$i)) + 8|0);
      $81 = HEAP32[$next$i$i>>2]|0;
      $cmp3$i$i = ($81|0)==(0|0);
      if ($cmp3$i$i) {
       label = 128;
       break L180;
      } else {
       $sp$0$i$i = $81;
      }
     }
     $add77$i = (($add9$i) - ($70))|0;
     $and80$i = $add77$i & $neg$i137;
     $cmp81$i = ($and80$i>>>0)<(2147483647);
     if ($cmp81$i) {
      $size$i$i$le = ((($sp$0$i$i)) + 4|0);
      $call83$i = (_sbrk(($and80$i|0))|0);
      $86 = HEAP32[$sp$0$i$i>>2]|0;
      $87 = HEAP32[$size$i$i$le>>2]|0;
      $add$ptr$i141 = (($86) + ($87)|0);
      $cmp85$i = ($call83$i|0)==($add$ptr$i141|0);
      if ($cmp85$i) {
       $cmp89$i = ($call83$i|0)==((-1)|0);
       if ($cmp89$i) {
        $tsize$2647482$i = $and80$i;
       } else {
        $tbase$795$i = $call83$i;$tsize$794$i = $and80$i;
        label = 145;
        break L178;
       }
      } else {
       $br$2$ph$i = $call83$i;$ssize$2$ph$i = $and80$i;
       label = 136;
      }
     } else {
      $tsize$2647482$i = 0;
     }
    }
   } while(0);
   do {
    if ((label|0) == 128) {
     $call37$i = (_sbrk(0)|0);
     $cmp38$i = ($call37$i|0)==((-1)|0);
     if ($cmp38$i) {
      $tsize$2647482$i = 0;
     } else {
      $82 = $call37$i;
      $83 = HEAP32[(2700)>>2]|0;
      $sub41$i = (($83) + -1)|0;
      $and42$i = $sub41$i & $82;
      $cmp43$i = ($and42$i|0)==(0);
      $add46$i = (($sub41$i) + ($82))|0;
      $neg48$i = (0 - ($83))|0;
      $and49$i = $add46$i & $neg48$i;
      $sub50$i = (($and49$i) - ($82))|0;
      $add51$i = $cmp43$i ? 0 : $sub50$i;
      $spec$select96$i = (($add51$i) + ($and11$i))|0;
      $84 = HEAP32[(2656)>>2]|0;
      $add54$i = (($spec$select96$i) + ($84))|0;
      $cmp55$i = ($spec$select96$i>>>0)>($nb$0>>>0);
      $cmp57$i = ($spec$select96$i>>>0)<(2147483647);
      $or$cond$i = $cmp55$i & $cmp57$i;
      if ($or$cond$i) {
       $85 = HEAP32[(2664)>>2]|0;
       $cmp60$i = ($85|0)==(0);
       if (!($cmp60$i)) {
        $cmp63$i = ($add54$i>>>0)<=($84>>>0);
        $cmp66$i140 = ($add54$i>>>0)>($85>>>0);
        $or$cond2$i = $cmp63$i | $cmp66$i140;
        if ($or$cond2$i) {
         $tsize$2647482$i = 0;
         break;
        }
       }
       $call68$i = (_sbrk(($spec$select96$i|0))|0);
       $cmp69$i = ($call68$i|0)==($call37$i|0);
       if ($cmp69$i) {
        $tbase$795$i = $call37$i;$tsize$794$i = $spec$select96$i;
        label = 145;
        break L178;
       } else {
        $br$2$ph$i = $call68$i;$ssize$2$ph$i = $spec$select96$i;
        label = 136;
       }
      } else {
       $tsize$2647482$i = 0;
      }
     }
    }
   } while(0);
   do {
    if ((label|0) == 136) {
     $sub112$i = (0 - ($ssize$2$ph$i))|0;
     $cmp91$i = ($br$2$ph$i|0)!=((-1)|0);
     $cmp93$i = ($ssize$2$ph$i>>>0)<(2147483647);
     $or$cond5$i = $cmp93$i & $cmp91$i;
     $cmp96$i = ($add$i135>>>0)>($ssize$2$ph$i>>>0);
     $or$cond7$i = $cmp96$i & $or$cond5$i;
     if (!($or$cond7$i)) {
      $cmp118$i = ($br$2$ph$i|0)==((-1)|0);
      if ($cmp118$i) {
       $tsize$2647482$i = 0;
       break;
      } else {
       $tbase$795$i = $br$2$ph$i;$tsize$794$i = $ssize$2$ph$i;
       label = 145;
       break L178;
      }
     }
     $88 = HEAP32[(2704)>>2]|0;
     $sub99$i = (($sub$i136) - ($ssize$2$ph$i))|0;
     $add101$i = (($sub99$i) + ($88))|0;
     $neg103$i = (0 - ($88))|0;
     $and104$i = $add101$i & $neg103$i;
     $cmp105$i = ($and104$i>>>0)<(2147483647);
     if (!($cmp105$i)) {
      $tbase$795$i = $br$2$ph$i;$tsize$794$i = $ssize$2$ph$i;
      label = 145;
      break L178;
     }
     $call107$i = (_sbrk(($and104$i|0))|0);
     $cmp108$i = ($call107$i|0)==((-1)|0);
     if ($cmp108$i) {
      (_sbrk(($sub112$i|0))|0);
      $tsize$2647482$i = 0;
      break;
     } else {
      $add110$i = (($and104$i) + ($ssize$2$ph$i))|0;
      $tbase$795$i = $br$2$ph$i;$tsize$794$i = $add110$i;
      label = 145;
      break L178;
     }
    }
   } while(0);
   $89 = HEAP32[(2668)>>2]|0;
   $or$i = $89 | 4;
   HEAP32[(2668)>>2] = $or$i;
   $tsize$4$i = $tsize$2647482$i;
   label = 143;
  } else {
   $tsize$4$i = 0;
   label = 143;
  }
 } while(0);
 if ((label|0) == 143) {
  $cmp127$i = ($and11$i>>>0)<(2147483647);
  if ($cmp127$i) {
   $call131$i = (_sbrk(($and11$i|0))|0);
   $call132$i = (_sbrk(0)|0);
   $cmp133$i = ($call131$i|0)!=((-1)|0);
   $cmp135$i = ($call132$i|0)!=((-1)|0);
   $or$cond4$i = $cmp133$i & $cmp135$i;
   $cmp137$i = ($call131$i>>>0)<($call132$i>>>0);
   $or$cond8$i = $cmp137$i & $or$cond4$i;
   $sub$ptr$lhs$cast$i = $call132$i;
   $sub$ptr$rhs$cast$i = $call131$i;
   $sub$ptr$sub$i = (($sub$ptr$lhs$cast$i) - ($sub$ptr$rhs$cast$i))|0;
   $add140$i = (($nb$0) + 40)|0;
   $cmp141$i = ($sub$ptr$sub$i>>>0)>($add140$i>>>0);
   $spec$select9$i = $cmp141$i ? $sub$ptr$sub$i : $tsize$4$i;
   $or$cond8$not$i = $or$cond8$i ^ 1;
   $cmp14799$i = ($call131$i|0)==((-1)|0);
   $not$cmp141$i = $cmp141$i ^ 1;
   $cmp147$i = $cmp14799$i | $not$cmp141$i;
   $or$cond97$i = $cmp147$i | $or$cond8$not$i;
   if (!($or$cond97$i)) {
    $tbase$795$i = $call131$i;$tsize$794$i = $spec$select9$i;
    label = 145;
   }
  }
 }
 if ((label|0) == 145) {
  $90 = HEAP32[(2656)>>2]|0;
  $add150$i = (($90) + ($tsize$794$i))|0;
  HEAP32[(2656)>>2] = $add150$i;
  $91 = HEAP32[(2660)>>2]|0;
  $cmp151$i = ($add150$i>>>0)>($91>>>0);
  if ($cmp151$i) {
   HEAP32[(2660)>>2] = $add150$i;
  }
  $92 = HEAP32[(2248)>>2]|0;
  $cmp157$i = ($92|0)==(0|0);
  L215: do {
   if ($cmp157$i) {
    $93 = HEAP32[(2240)>>2]|0;
    $cmp159$i = ($93|0)==(0|0);
    $cmp162$i = ($tbase$795$i>>>0)<($93>>>0);
    $or$cond11$i = $cmp159$i | $cmp162$i;
    if ($or$cond11$i) {
     HEAP32[(2240)>>2] = $tbase$795$i;
    }
    HEAP32[(2672)>>2] = $tbase$795$i;
    HEAP32[(2676)>>2] = $tsize$794$i;
    HEAP32[(2684)>>2] = 0;
    $94 = HEAP32[674]|0;
    HEAP32[(2260)>>2] = $94;
    HEAP32[(2256)>>2] = -1;
    HEAP32[(2276)>>2] = (2264);
    HEAP32[(2272)>>2] = (2264);
    HEAP32[(2284)>>2] = (2272);
    HEAP32[(2280)>>2] = (2272);
    HEAP32[(2292)>>2] = (2280);
    HEAP32[(2288)>>2] = (2280);
    HEAP32[(2300)>>2] = (2288);
    HEAP32[(2296)>>2] = (2288);
    HEAP32[(2308)>>2] = (2296);
    HEAP32[(2304)>>2] = (2296);
    HEAP32[(2316)>>2] = (2304);
    HEAP32[(2312)>>2] = (2304);
    HEAP32[(2324)>>2] = (2312);
    HEAP32[(2320)>>2] = (2312);
    HEAP32[(2332)>>2] = (2320);
    HEAP32[(2328)>>2] = (2320);
    HEAP32[(2340)>>2] = (2328);
    HEAP32[(2336)>>2] = (2328);
    HEAP32[(2348)>>2] = (2336);
    HEAP32[(2344)>>2] = (2336);
    HEAP32[(2356)>>2] = (2344);
    HEAP32[(2352)>>2] = (2344);
    HEAP32[(2364)>>2] = (2352);
    HEAP32[(2360)>>2] = (2352);
    HEAP32[(2372)>>2] = (2360);
    HEAP32[(2368)>>2] = (2360);
    HEAP32[(2380)>>2] = (2368);
    HEAP32[(2376)>>2] = (2368);
    HEAP32[(2388)>>2] = (2376);
    HEAP32[(2384)>>2] = (2376);
    HEAP32[(2396)>>2] = (2384);
    HEAP32[(2392)>>2] = (2384);
    HEAP32[(2404)>>2] = (2392);
    HEAP32[(2400)>>2] = (2392);
    HEAP32[(2412)>>2] = (2400);
    HEAP32[(2408)>>2] = (2400);
    HEAP32[(2420)>>2] = (2408);
    HEAP32[(2416)>>2] = (2408);
    HEAP32[(2428)>>2] = (2416);
    HEAP32[(2424)>>2] = (2416);
    HEAP32[(2436)>>2] = (2424);
    HEAP32[(2432)>>2] = (2424);
    HEAP32[(2444)>>2] = (2432);
    HEAP32[(2440)>>2] = (2432);
    HEAP32[(2452)>>2] = (2440);
    HEAP32[(2448)>>2] = (2440);
    HEAP32[(2460)>>2] = (2448);
    HEAP32[(2456)>>2] = (2448);
    HEAP32[(2468)>>2] = (2456);
    HEAP32[(2464)>>2] = (2456);
    HEAP32[(2476)>>2] = (2464);
    HEAP32[(2472)>>2] = (2464);
    HEAP32[(2484)>>2] = (2472);
    HEAP32[(2480)>>2] = (2472);
    HEAP32[(2492)>>2] = (2480);
    HEAP32[(2488)>>2] = (2480);
    HEAP32[(2500)>>2] = (2488);
    HEAP32[(2496)>>2] = (2488);
    HEAP32[(2508)>>2] = (2496);
    HEAP32[(2504)>>2] = (2496);
    HEAP32[(2516)>>2] = (2504);
    HEAP32[(2512)>>2] = (2504);
    HEAP32[(2524)>>2] = (2512);
    HEAP32[(2520)>>2] = (2512);
    $sub172$i = (($tsize$794$i) + -40)|0;
    $add$ptr$i43$i = ((($tbase$795$i)) + 8|0);
    $95 = $add$ptr$i43$i;
    $and$i44$i = $95 & 7;
    $cmp$i45$i = ($and$i44$i|0)==(0);
    $sub$i46$i = (0 - ($95))|0;
    $and3$i47$i = $sub$i46$i & 7;
    $cond$i48$i = $cmp$i45$i ? 0 : $and3$i47$i;
    $add$ptr4$i49$i = (($tbase$795$i) + ($cond$i48$i)|0);
    $sub5$i50$i = (($sub172$i) - ($cond$i48$i))|0;
    HEAP32[(2248)>>2] = $add$ptr4$i49$i;
    HEAP32[(2236)>>2] = $sub5$i50$i;
    $or$i51$i = $sub5$i50$i | 1;
    $head$i52$i = ((($add$ptr4$i49$i)) + 4|0);
    HEAP32[$head$i52$i>>2] = $or$i51$i;
    $add$ptr6$i53$i = (($tbase$795$i) + ($sub172$i)|0);
    $head7$i54$i = ((($add$ptr6$i53$i)) + 4|0);
    HEAP32[$head7$i54$i>>2] = 40;
    $96 = HEAP32[(2712)>>2]|0;
    HEAP32[(2252)>>2] = $96;
   } else {
    $sp$0112$i = (2672);
    while(1) {
     $97 = HEAP32[$sp$0112$i>>2]|0;
     $size188$i = ((($sp$0112$i)) + 4|0);
     $98 = HEAP32[$size188$i>>2]|0;
     $add$ptr189$i = (($97) + ($98)|0);
     $cmp190$i = ($tbase$795$i|0)==($add$ptr189$i|0);
     if ($cmp190$i) {
      label = 154;
      break;
     }
     $next$i = ((($sp$0112$i)) + 8|0);
     $99 = HEAP32[$next$i>>2]|0;
     $cmp186$i = ($99|0)==(0|0);
     if ($cmp186$i) {
      break;
     } else {
      $sp$0112$i = $99;
     }
    }
    if ((label|0) == 154) {
     $size188$i$le = ((($sp$0112$i)) + 4|0);
     $sflags193$i = ((($sp$0112$i)) + 12|0);
     $100 = HEAP32[$sflags193$i>>2]|0;
     $and194$i = $100 & 8;
     $tobool195$i = ($and194$i|0)==(0);
     if ($tobool195$i) {
      $cmp203$i = ($97>>>0)<=($92>>>0);
      $cmp209$i = ($tbase$795$i>>>0)>($92>>>0);
      $or$cond98$i = $cmp209$i & $cmp203$i;
      if ($or$cond98$i) {
       $add212$i = (($98) + ($tsize$794$i))|0;
       HEAP32[$size188$i$le>>2] = $add212$i;
       $101 = HEAP32[(2236)>>2]|0;
       $add215$i = (($101) + ($tsize$794$i))|0;
       $add$ptr$i35$i = ((($92)) + 8|0);
       $102 = $add$ptr$i35$i;
       $and$i36$i = $102 & 7;
       $cmp$i37$i = ($and$i36$i|0)==(0);
       $sub$i38$i = (0 - ($102))|0;
       $and3$i39$i = $sub$i38$i & 7;
       $cond$i40$i = $cmp$i37$i ? 0 : $and3$i39$i;
       $add$ptr4$i41$i = (($92) + ($cond$i40$i)|0);
       $sub5$i$i = (($add215$i) - ($cond$i40$i))|0;
       HEAP32[(2248)>>2] = $add$ptr4$i41$i;
       HEAP32[(2236)>>2] = $sub5$i$i;
       $or$i$i = $sub5$i$i | 1;
       $head$i42$i = ((($add$ptr4$i41$i)) + 4|0);
       HEAP32[$head$i42$i>>2] = $or$i$i;
       $add$ptr6$i$i = (($92) + ($add215$i)|0);
       $head7$i$i = ((($add$ptr6$i$i)) + 4|0);
       HEAP32[$head7$i$i>>2] = 40;
       $103 = HEAP32[(2712)>>2]|0;
       HEAP32[(2252)>>2] = $103;
       break;
      }
     }
    }
    $104 = HEAP32[(2240)>>2]|0;
    $cmp218$i = ($tbase$795$i>>>0)<($104>>>0);
    if ($cmp218$i) {
     HEAP32[(2240)>>2] = $tbase$795$i;
    }
    $add$ptr227$i = (($tbase$795$i) + ($tsize$794$i)|0);
    $sp$1111$i = (2672);
    while(1) {
     $105 = HEAP32[$sp$1111$i>>2]|0;
     $cmp228$i = ($105|0)==($add$ptr227$i|0);
     if ($cmp228$i) {
      label = 162;
      break;
     }
     $next231$i = ((($sp$1111$i)) + 8|0);
     $106 = HEAP32[$next231$i>>2]|0;
     $cmp224$i = ($106|0)==(0|0);
     if ($cmp224$i) {
      break;
     } else {
      $sp$1111$i = $106;
     }
    }
    if ((label|0) == 162) {
     $sflags235$i = ((($sp$1111$i)) + 12|0);
     $107 = HEAP32[$sflags235$i>>2]|0;
     $and236$i = $107 & 8;
     $tobool237$i = ($and236$i|0)==(0);
     if ($tobool237$i) {
      HEAP32[$sp$1111$i>>2] = $tbase$795$i;
      $size245$i = ((($sp$1111$i)) + 4|0);
      $108 = HEAP32[$size245$i>>2]|0;
      $add246$i = (($108) + ($tsize$794$i))|0;
      HEAP32[$size245$i>>2] = $add246$i;
      $add$ptr$i$i = ((($tbase$795$i)) + 8|0);
      $109 = $add$ptr$i$i;
      $and$i14$i = $109 & 7;
      $cmp$i15$i = ($and$i14$i|0)==(0);
      $sub$i16$i = (0 - ($109))|0;
      $and3$i$i = $sub$i16$i & 7;
      $cond$i17$i = $cmp$i15$i ? 0 : $and3$i$i;
      $add$ptr4$i$i = (($tbase$795$i) + ($cond$i17$i)|0);
      $add$ptr5$i$i = ((($add$ptr227$i)) + 8|0);
      $110 = $add$ptr5$i$i;
      $and6$i18$i = $110 & 7;
      $cmp7$i$i = ($and6$i18$i|0)==(0);
      $sub12$i$i = (0 - ($110))|0;
      $and13$i$i = $sub12$i$i & 7;
      $cond15$i$i = $cmp7$i$i ? 0 : $and13$i$i;
      $add$ptr16$i$i = (($add$ptr227$i) + ($cond15$i$i)|0);
      $sub$ptr$lhs$cast$i19$i = $add$ptr16$i$i;
      $sub$ptr$rhs$cast$i20$i = $add$ptr4$i$i;
      $sub$ptr$sub$i21$i = (($sub$ptr$lhs$cast$i19$i) - ($sub$ptr$rhs$cast$i20$i))|0;
      $add$ptr17$i$i = (($add$ptr4$i$i) + ($nb$0)|0);
      $sub18$i$i = (($sub$ptr$sub$i21$i) - ($nb$0))|0;
      $or19$i$i = $nb$0 | 3;
      $head$i22$i = ((($add$ptr4$i$i)) + 4|0);
      HEAP32[$head$i22$i>>2] = $or19$i$i;
      $cmp20$i$i = ($92|0)==($add$ptr16$i$i|0);
      L238: do {
       if ($cmp20$i$i) {
        $111 = HEAP32[(2236)>>2]|0;
        $add$i$i = (($111) + ($sub18$i$i))|0;
        HEAP32[(2236)>>2] = $add$i$i;
        HEAP32[(2248)>>2] = $add$ptr17$i$i;
        $or22$i$i = $add$i$i | 1;
        $head23$i$i = ((($add$ptr17$i$i)) + 4|0);
        HEAP32[$head23$i$i>>2] = $or22$i$i;
       } else {
        $112 = HEAP32[(2244)>>2]|0;
        $cmp24$i$i = ($112|0)==($add$ptr16$i$i|0);
        if ($cmp24$i$i) {
         $113 = HEAP32[(2232)>>2]|0;
         $add26$i$i = (($113) + ($sub18$i$i))|0;
         HEAP32[(2232)>>2] = $add26$i$i;
         HEAP32[(2244)>>2] = $add$ptr17$i$i;
         $or28$i$i = $add26$i$i | 1;
         $head29$i$i = ((($add$ptr17$i$i)) + 4|0);
         HEAP32[$head29$i$i>>2] = $or28$i$i;
         $add$ptr30$i$i = (($add$ptr17$i$i) + ($add26$i$i)|0);
         HEAP32[$add$ptr30$i$i>>2] = $add26$i$i;
         break;
        }
        $head32$i$i = ((($add$ptr16$i$i)) + 4|0);
        $114 = HEAP32[$head32$i$i>>2]|0;
        $and33$i$i = $114 & 3;
        $cmp34$i$i = ($and33$i$i|0)==(1);
        if ($cmp34$i$i) {
         $and37$i$i = $114 & -8;
         $shr$i25$i = $114 >>> 3;
         $cmp38$i$i = ($114>>>0)<(256);
         L246: do {
          if ($cmp38$i$i) {
           $fd$i$i = ((($add$ptr16$i$i)) + 8|0);
           $115 = HEAP32[$fd$i$i>>2]|0;
           $bk$i26$i = ((($add$ptr16$i$i)) + 12|0);
           $116 = HEAP32[$bk$i26$i>>2]|0;
           $cmp46$i$i = ($116|0)==($115|0);
           if ($cmp46$i$i) {
            $shl48$i$i = 1 << $shr$i25$i;
            $neg$i$i = $shl48$i$i ^ -1;
            $117 = HEAP32[556]|0;
            $and49$i$i = $117 & $neg$i$i;
            HEAP32[556] = $and49$i$i;
            break;
           } else {
            $bk67$i$i = ((($115)) + 12|0);
            HEAP32[$bk67$i$i>>2] = $116;
            $fd68$i$i = ((($116)) + 8|0);
            HEAP32[$fd68$i$i>>2] = $115;
            break;
           }
          } else {
           $parent$i27$i = ((($add$ptr16$i$i)) + 24|0);
           $118 = HEAP32[$parent$i27$i>>2]|0;
           $bk74$i$i = ((($add$ptr16$i$i)) + 12|0);
           $119 = HEAP32[$bk74$i$i>>2]|0;
           $cmp75$i$i = ($119|0)==($add$ptr16$i$i|0);
           do {
            if ($cmp75$i$i) {
             $child$i$i = ((($add$ptr16$i$i)) + 16|0);
             $arrayidx96$i$i = ((($child$i$i)) + 4|0);
             $121 = HEAP32[$arrayidx96$i$i>>2]|0;
             $cmp97$i$i = ($121|0)==(0|0);
             if ($cmp97$i$i) {
              $122 = HEAP32[$child$i$i>>2]|0;
              $cmp100$i$i = ($122|0)==(0|0);
              if ($cmp100$i$i) {
               $R$3$i$i = 0;
               break;
              } else {
               $R$1$i$i$ph = $122;$RP$1$i$i$ph = $child$i$i;
              }
             } else {
              $R$1$i$i$ph = $121;$RP$1$i$i$ph = $arrayidx96$i$i;
             }
             $R$1$i$i = $R$1$i$i$ph;$RP$1$i$i = $RP$1$i$i$ph;
             while(1) {
              $arrayidx103$i$i = ((($R$1$i$i)) + 20|0);
              $123 = HEAP32[$arrayidx103$i$i>>2]|0;
              $cmp104$i$i = ($123|0)==(0|0);
              if ($cmp104$i$i) {
               $arrayidx107$i$i = ((($R$1$i$i)) + 16|0);
               $124 = HEAP32[$arrayidx107$i$i>>2]|0;
               $cmp108$i$i = ($124|0)==(0|0);
               if ($cmp108$i$i) {
                break;
               } else {
                $R$1$i$i$be = $124;$RP$1$i$i$be = $arrayidx107$i$i;
               }
              } else {
               $R$1$i$i$be = $123;$RP$1$i$i$be = $arrayidx103$i$i;
              }
              $R$1$i$i = $R$1$i$i$be;$RP$1$i$i = $RP$1$i$i$be;
             }
             HEAP32[$RP$1$i$i>>2] = 0;
             $R$3$i$i = $R$1$i$i;
            } else {
             $fd78$i$i = ((($add$ptr16$i$i)) + 8|0);
             $120 = HEAP32[$fd78$i$i>>2]|0;
             $bk91$i$i = ((($120)) + 12|0);
             HEAP32[$bk91$i$i>>2] = $119;
             $fd92$i$i = ((($119)) + 8|0);
             HEAP32[$fd92$i$i>>2] = $120;
             $R$3$i$i = $119;
            }
           } while(0);
           $cmp120$i28$i = ($118|0)==(0|0);
           if ($cmp120$i28$i) {
            break;
           }
           $index$i29$i = ((($add$ptr16$i$i)) + 28|0);
           $125 = HEAP32[$index$i29$i>>2]|0;
           $arrayidx123$i$i = (2528 + ($125<<2)|0);
           $126 = HEAP32[$arrayidx123$i$i>>2]|0;
           $cmp124$i$i = ($126|0)==($add$ptr16$i$i|0);
           do {
            if ($cmp124$i$i) {
             HEAP32[$arrayidx123$i$i>>2] = $R$3$i$i;
             $cond1$i$i = ($R$3$i$i|0)==(0|0);
             if (!($cond1$i$i)) {
              break;
             }
             $shl131$i$i = 1 << $125;
             $neg132$i$i = $shl131$i$i ^ -1;
             $127 = HEAP32[(2228)>>2]|0;
             $and133$i$i = $127 & $neg132$i$i;
             HEAP32[(2228)>>2] = $and133$i$i;
             break L246;
            } else {
             $arrayidx143$i$i = ((($118)) + 16|0);
             $128 = HEAP32[$arrayidx143$i$i>>2]|0;
             $cmp144$i$i = ($128|0)==($add$ptr16$i$i|0);
             $arrayidx151$i$i = ((($118)) + 20|0);
             $arrayidx151$i$i$sink = $cmp144$i$i ? $arrayidx143$i$i : $arrayidx151$i$i;
             HEAP32[$arrayidx151$i$i$sink>>2] = $R$3$i$i;
             $cmp156$i$i = ($R$3$i$i|0)==(0|0);
             if ($cmp156$i$i) {
              break L246;
             }
            }
           } while(0);
           $parent165$i$i = ((($R$3$i$i)) + 24|0);
           HEAP32[$parent165$i$i>>2] = $118;
           $child166$i$i = ((($add$ptr16$i$i)) + 16|0);
           $129 = HEAP32[$child166$i$i>>2]|0;
           $cmp168$i$i = ($129|0)==(0|0);
           if (!($cmp168$i$i)) {
            $arrayidx178$i$i = ((($R$3$i$i)) + 16|0);
            HEAP32[$arrayidx178$i$i>>2] = $129;
            $parent179$i$i = ((($129)) + 24|0);
            HEAP32[$parent179$i$i>>2] = $R$3$i$i;
           }
           $arrayidx184$i$i = ((($child166$i$i)) + 4|0);
           $130 = HEAP32[$arrayidx184$i$i>>2]|0;
           $cmp185$i$i = ($130|0)==(0|0);
           if ($cmp185$i$i) {
            break;
           }
           $arrayidx195$i$i = ((($R$3$i$i)) + 20|0);
           HEAP32[$arrayidx195$i$i>>2] = $130;
           $parent196$i$i = ((($130)) + 24|0);
           HEAP32[$parent196$i$i>>2] = $R$3$i$i;
          }
         } while(0);
         $add$ptr205$i$i = (($add$ptr16$i$i) + ($and37$i$i)|0);
         $add206$i$i = (($and37$i$i) + ($sub18$i$i))|0;
         $oldfirst$0$i$i = $add$ptr205$i$i;$qsize$0$i$i = $add206$i$i;
        } else {
         $oldfirst$0$i$i = $add$ptr16$i$i;$qsize$0$i$i = $sub18$i$i;
        }
        $head208$i$i = ((($oldfirst$0$i$i)) + 4|0);
        $131 = HEAP32[$head208$i$i>>2]|0;
        $and209$i$i = $131 & -2;
        HEAP32[$head208$i$i>>2] = $and209$i$i;
        $or210$i$i = $qsize$0$i$i | 1;
        $head211$i$i = ((($add$ptr17$i$i)) + 4|0);
        HEAP32[$head211$i$i>>2] = $or210$i$i;
        $add$ptr212$i$i = (($add$ptr17$i$i) + ($qsize$0$i$i)|0);
        HEAP32[$add$ptr212$i$i>>2] = $qsize$0$i$i;
        $shr214$i$i = $qsize$0$i$i >>> 3;
        $cmp215$i$i = ($qsize$0$i$i>>>0)<(256);
        if ($cmp215$i$i) {
         $shl222$i$i = $shr214$i$i << 1;
         $arrayidx223$i$i = (2264 + ($shl222$i$i<<2)|0);
         $132 = HEAP32[556]|0;
         $shl226$i$i = 1 << $shr214$i$i;
         $and227$i$i = $132 & $shl226$i$i;
         $tobool228$i$i = ($and227$i$i|0)==(0);
         if ($tobool228$i$i) {
          $or232$i$i = $132 | $shl226$i$i;
          HEAP32[556] = $or232$i$i;
          $$pre$i31$i = ((($arrayidx223$i$i)) + 8|0);
          $$pre$phi$i32$iZ2D = $$pre$i31$i;$F224$0$i$i = $arrayidx223$i$i;
         } else {
          $133 = ((($arrayidx223$i$i)) + 8|0);
          $134 = HEAP32[$133>>2]|0;
          $$pre$phi$i32$iZ2D = $133;$F224$0$i$i = $134;
         }
         HEAP32[$$pre$phi$i32$iZ2D>>2] = $add$ptr17$i$i;
         $bk246$i$i = ((($F224$0$i$i)) + 12|0);
         HEAP32[$bk246$i$i>>2] = $add$ptr17$i$i;
         $fd247$i$i = ((($add$ptr17$i$i)) + 8|0);
         HEAP32[$fd247$i$i>>2] = $F224$0$i$i;
         $bk248$i$i = ((($add$ptr17$i$i)) + 12|0);
         HEAP32[$bk248$i$i>>2] = $arrayidx223$i$i;
         break;
        }
        $shr253$i$i = $qsize$0$i$i >>> 8;
        $cmp254$i$i = ($shr253$i$i|0)==(0);
        do {
         if ($cmp254$i$i) {
          $I252$0$i$i = 0;
         } else {
          $cmp258$i$i = ($qsize$0$i$i>>>0)>(16777215);
          if ($cmp258$i$i) {
           $I252$0$i$i = 31;
           break;
          }
          $sub262$i$i = (($shr253$i$i) + 1048320)|0;
          $shr263$i$i = $sub262$i$i >>> 16;
          $and264$i$i = $shr263$i$i & 8;
          $shl265$i$i = $shr253$i$i << $and264$i$i;
          $sub266$i$i = (($shl265$i$i) + 520192)|0;
          $shr267$i$i = $sub266$i$i >>> 16;
          $and268$i$i = $shr267$i$i & 4;
          $add269$i$i = $and268$i$i | $and264$i$i;
          $shl270$i$i = $shl265$i$i << $and268$i$i;
          $sub271$i$i = (($shl270$i$i) + 245760)|0;
          $shr272$i$i = $sub271$i$i >>> 16;
          $and273$i$i = $shr272$i$i & 2;
          $add274$i$i = $add269$i$i | $and273$i$i;
          $sub275$i$i = (14 - ($add274$i$i))|0;
          $shl276$i$i = $shl270$i$i << $and273$i$i;
          $shr277$i$i = $shl276$i$i >>> 15;
          $add278$i$i = (($sub275$i$i) + ($shr277$i$i))|0;
          $shl279$i$i = $add278$i$i << 1;
          $add280$i$i = (($add278$i$i) + 7)|0;
          $shr281$i$i = $qsize$0$i$i >>> $add280$i$i;
          $and282$i$i = $shr281$i$i & 1;
          $add283$i$i = $and282$i$i | $shl279$i$i;
          $I252$0$i$i = $add283$i$i;
         }
        } while(0);
        $arrayidx287$i$i = (2528 + ($I252$0$i$i<<2)|0);
        $index288$i$i = ((($add$ptr17$i$i)) + 28|0);
        HEAP32[$index288$i$i>>2] = $I252$0$i$i;
        $child289$i$i = ((($add$ptr17$i$i)) + 16|0);
        $arrayidx290$i$i = ((($child289$i$i)) + 4|0);
        HEAP32[$arrayidx290$i$i>>2] = 0;
        HEAP32[$child289$i$i>>2] = 0;
        $135 = HEAP32[(2228)>>2]|0;
        $shl294$i$i = 1 << $I252$0$i$i;
        $and295$i$i = $135 & $shl294$i$i;
        $tobool296$i$i = ($and295$i$i|0)==(0);
        if ($tobool296$i$i) {
         $or300$i$i = $135 | $shl294$i$i;
         HEAP32[(2228)>>2] = $or300$i$i;
         HEAP32[$arrayidx287$i$i>>2] = $add$ptr17$i$i;
         $parent301$i$i = ((($add$ptr17$i$i)) + 24|0);
         HEAP32[$parent301$i$i>>2] = $arrayidx287$i$i;
         $bk302$i$i = ((($add$ptr17$i$i)) + 12|0);
         HEAP32[$bk302$i$i>>2] = $add$ptr17$i$i;
         $fd303$i$i = ((($add$ptr17$i$i)) + 8|0);
         HEAP32[$fd303$i$i>>2] = $add$ptr17$i$i;
         break;
        }
        $136 = HEAP32[$arrayidx287$i$i>>2]|0;
        $head3174$i$i = ((($136)) + 4|0);
        $137 = HEAP32[$head3174$i$i>>2]|0;
        $and3185$i$i = $137 & -8;
        $cmp3196$i$i = ($and3185$i$i|0)==($qsize$0$i$i|0);
        L291: do {
         if ($cmp3196$i$i) {
          $T$0$lcssa$i34$i = $136;
         } else {
          $cmp306$i$i = ($I252$0$i$i|0)==(31);
          $shr310$i$i = $I252$0$i$i >>> 1;
          $sub313$i$i = (25 - ($shr310$i$i))|0;
          $cond315$i$i = $cmp306$i$i ? 0 : $sub313$i$i;
          $shl316$i$i = $qsize$0$i$i << $cond315$i$i;
          $K305$08$i$i = $shl316$i$i;$T$07$i$i = $136;
          while(1) {
           $shr323$i$i = $K305$08$i$i >>> 31;
           $arrayidx325$i$i = (((($T$07$i$i)) + 16|0) + ($shr323$i$i<<2)|0);
           $138 = HEAP32[$arrayidx325$i$i>>2]|0;
           $cmp327$i$i = ($138|0)==(0|0);
           if ($cmp327$i$i) {
            break;
           }
           $shl326$i$i = $K305$08$i$i << 1;
           $head317$i$i = ((($138)) + 4|0);
           $139 = HEAP32[$head317$i$i>>2]|0;
           $and318$i$i = $139 & -8;
           $cmp319$i$i = ($and318$i$i|0)==($qsize$0$i$i|0);
           if ($cmp319$i$i) {
            $T$0$lcssa$i34$i = $138;
            break L291;
           } else {
            $K305$08$i$i = $shl326$i$i;$T$07$i$i = $138;
           }
          }
          HEAP32[$arrayidx325$i$i>>2] = $add$ptr17$i$i;
          $parent337$i$i = ((($add$ptr17$i$i)) + 24|0);
          HEAP32[$parent337$i$i>>2] = $T$07$i$i;
          $bk338$i$i = ((($add$ptr17$i$i)) + 12|0);
          HEAP32[$bk338$i$i>>2] = $add$ptr17$i$i;
          $fd339$i$i = ((($add$ptr17$i$i)) + 8|0);
          HEAP32[$fd339$i$i>>2] = $add$ptr17$i$i;
          break L238;
         }
        } while(0);
        $fd344$i$i = ((($T$0$lcssa$i34$i)) + 8|0);
        $140 = HEAP32[$fd344$i$i>>2]|0;
        $bk357$i$i = ((($140)) + 12|0);
        HEAP32[$bk357$i$i>>2] = $add$ptr17$i$i;
        HEAP32[$fd344$i$i>>2] = $add$ptr17$i$i;
        $fd359$i$i = ((($add$ptr17$i$i)) + 8|0);
        HEAP32[$fd359$i$i>>2] = $140;
        $bk360$i$i = ((($add$ptr17$i$i)) + 12|0);
        HEAP32[$bk360$i$i>>2] = $T$0$lcssa$i34$i;
        $parent361$i$i = ((($add$ptr17$i$i)) + 24|0);
        HEAP32[$parent361$i$i>>2] = 0;
       }
      } while(0);
      $add$ptr369$i$i = ((($add$ptr4$i$i)) + 8|0);
      $retval$0 = $add$ptr369$i$i;
      STACKTOP = sp;return ($retval$0|0);
     }
    }
    $sp$0$i$i$i = (2672);
    while(1) {
     $141 = HEAP32[$sp$0$i$i$i>>2]|0;
     $cmp$i$i$i = ($141>>>0)>($92>>>0);
     if (!($cmp$i$i$i)) {
      $size$i$i$i = ((($sp$0$i$i$i)) + 4|0);
      $142 = HEAP32[$size$i$i$i>>2]|0;
      $add$ptr$i$i$i = (($141) + ($142)|0);
      $cmp2$i$i$i = ($add$ptr$i$i$i>>>0)>($92>>>0);
      if ($cmp2$i$i$i) {
       break;
      }
     }
     $next$i$i$i = ((($sp$0$i$i$i)) + 8|0);
     $143 = HEAP32[$next$i$i$i>>2]|0;
     $sp$0$i$i$i = $143;
    }
    $add$ptr2$i$i = ((($add$ptr$i$i$i)) + -47|0);
    $add$ptr3$i$i = ((($add$ptr2$i$i)) + 8|0);
    $144 = $add$ptr3$i$i;
    $and$i$i = $144 & 7;
    $cmp$i12$i = ($and$i$i|0)==(0);
    $sub$i$i = (0 - ($144))|0;
    $and6$i13$i = $sub$i$i & 7;
    $cond$i$i = $cmp$i12$i ? 0 : $and6$i13$i;
    $add$ptr7$i$i = (($add$ptr2$i$i) + ($cond$i$i)|0);
    $add$ptr81$i$i = ((($92)) + 16|0);
    $cmp9$i$i = ($add$ptr7$i$i>>>0)<($add$ptr81$i$i>>>0);
    $cond13$i$i = $cmp9$i$i ? $92 : $add$ptr7$i$i;
    $add$ptr14$i$i = ((($cond13$i$i)) + 8|0);
    $add$ptr15$i$i = ((($cond13$i$i)) + 24|0);
    $sub16$i$i = (($tsize$794$i) + -40)|0;
    $add$ptr$i2$i$i = ((($tbase$795$i)) + 8|0);
    $145 = $add$ptr$i2$i$i;
    $and$i$i$i = $145 & 7;
    $cmp$i3$i$i = ($and$i$i$i|0)==(0);
    $sub$i$i$i = (0 - ($145))|0;
    $and3$i$i$i = $sub$i$i$i & 7;
    $cond$i$i$i = $cmp$i3$i$i ? 0 : $and3$i$i$i;
    $add$ptr4$i$i$i = (($tbase$795$i) + ($cond$i$i$i)|0);
    $sub5$i$i$i = (($sub16$i$i) - ($cond$i$i$i))|0;
    HEAP32[(2248)>>2] = $add$ptr4$i$i$i;
    HEAP32[(2236)>>2] = $sub5$i$i$i;
    $or$i$i$i = $sub5$i$i$i | 1;
    $head$i$i$i = ((($add$ptr4$i$i$i)) + 4|0);
    HEAP32[$head$i$i$i>>2] = $or$i$i$i;
    $add$ptr6$i$i$i = (($tbase$795$i) + ($sub16$i$i)|0);
    $head7$i$i$i = ((($add$ptr6$i$i$i)) + 4|0);
    HEAP32[$head7$i$i$i>>2] = 40;
    $146 = HEAP32[(2712)>>2]|0;
    HEAP32[(2252)>>2] = $146;
    $head$i$i = ((($cond13$i$i)) + 4|0);
    HEAP32[$head$i$i>>2] = 27;
    ;HEAP32[$add$ptr14$i$i>>2]=HEAP32[(2672)>>2]|0;HEAP32[$add$ptr14$i$i+4>>2]=HEAP32[(2672)+4>>2]|0;HEAP32[$add$ptr14$i$i+8>>2]=HEAP32[(2672)+8>>2]|0;HEAP32[$add$ptr14$i$i+12>>2]=HEAP32[(2672)+12>>2]|0;
    HEAP32[(2672)>>2] = $tbase$795$i;
    HEAP32[(2676)>>2] = $tsize$794$i;
    HEAP32[(2684)>>2] = 0;
    HEAP32[(2680)>>2] = $add$ptr14$i$i;
    $147 = $add$ptr15$i$i;
    while(1) {
     $add$ptr24$i$i = ((($147)) + 4|0);
     HEAP32[$add$ptr24$i$i>>2] = 7;
     $head26$i$i = ((($147)) + 8|0);
     $cmp27$i$i = ($head26$i$i>>>0)<($add$ptr$i$i$i>>>0);
     if ($cmp27$i$i) {
      $147 = $add$ptr24$i$i;
     } else {
      break;
     }
    }
    $cmp28$i$i = ($cond13$i$i|0)==($92|0);
    if (!($cmp28$i$i)) {
     $sub$ptr$lhs$cast$i$i = $cond13$i$i;
     $sub$ptr$rhs$cast$i$i = $92;
     $sub$ptr$sub$i$i = (($sub$ptr$lhs$cast$i$i) - ($sub$ptr$rhs$cast$i$i))|0;
     $148 = HEAP32[$head$i$i>>2]|0;
     $and32$i$i = $148 & -2;
     HEAP32[$head$i$i>>2] = $and32$i$i;
     $or33$i$i = $sub$ptr$sub$i$i | 1;
     $head34$i$i = ((($92)) + 4|0);
     HEAP32[$head34$i$i>>2] = $or33$i$i;
     HEAP32[$cond13$i$i>>2] = $sub$ptr$sub$i$i;
     $shr$i$i = $sub$ptr$sub$i$i >>> 3;
     $cmp36$i$i = ($sub$ptr$sub$i$i>>>0)<(256);
     if ($cmp36$i$i) {
      $shl$i$i = $shr$i$i << 1;
      $arrayidx$i$i = (2264 + ($shl$i$i<<2)|0);
      $149 = HEAP32[556]|0;
      $shl39$i$i = 1 << $shr$i$i;
      $and40$i$i = $149 & $shl39$i$i;
      $tobool$i$i = ($and40$i$i|0)==(0);
      if ($tobool$i$i) {
       $or44$i$i = $149 | $shl39$i$i;
       HEAP32[556] = $or44$i$i;
       $$pre$i$i = ((($arrayidx$i$i)) + 8|0);
       $$pre$phi$i$iZ2D = $$pre$i$i;$F$0$i$i = $arrayidx$i$i;
      } else {
       $150 = ((($arrayidx$i$i)) + 8|0);
       $151 = HEAP32[$150>>2]|0;
       $$pre$phi$i$iZ2D = $150;$F$0$i$i = $151;
      }
      HEAP32[$$pre$phi$i$iZ2D>>2] = $92;
      $bk$i$i = ((($F$0$i$i)) + 12|0);
      HEAP32[$bk$i$i>>2] = $92;
      $fd54$i$i = ((($92)) + 8|0);
      HEAP32[$fd54$i$i>>2] = $F$0$i$i;
      $bk55$i$i = ((($92)) + 12|0);
      HEAP32[$bk55$i$i>>2] = $arrayidx$i$i;
      break;
     }
     $shr58$i$i = $sub$ptr$sub$i$i >>> 8;
     $cmp59$i$i = ($shr58$i$i|0)==(0);
     if ($cmp59$i$i) {
      $I57$0$i$i = 0;
     } else {
      $cmp63$i$i = ($sub$ptr$sub$i$i>>>0)>(16777215);
      if ($cmp63$i$i) {
       $I57$0$i$i = 31;
      } else {
       $sub67$i$i = (($shr58$i$i) + 1048320)|0;
       $shr68$i$i = $sub67$i$i >>> 16;
       $and69$i$i = $shr68$i$i & 8;
       $shl70$i$i = $shr58$i$i << $and69$i$i;
       $sub71$i$i = (($shl70$i$i) + 520192)|0;
       $shr72$i$i = $sub71$i$i >>> 16;
       $and73$i$i = $shr72$i$i & 4;
       $add74$i$i = $and73$i$i | $and69$i$i;
       $shl75$i$i = $shl70$i$i << $and73$i$i;
       $sub76$i$i = (($shl75$i$i) + 245760)|0;
       $shr77$i$i = $sub76$i$i >>> 16;
       $and78$i$i = $shr77$i$i & 2;
       $add79$i$i = $add74$i$i | $and78$i$i;
       $sub80$i$i = (14 - ($add79$i$i))|0;
       $shl81$i$i = $shl75$i$i << $and78$i$i;
       $shr82$i$i = $shl81$i$i >>> 15;
       $add83$i$i = (($sub80$i$i) + ($shr82$i$i))|0;
       $shl84$i$i = $add83$i$i << 1;
       $add85$i$i = (($add83$i$i) + 7)|0;
       $shr86$i$i = $sub$ptr$sub$i$i >>> $add85$i$i;
       $and87$i$i = $shr86$i$i & 1;
       $add88$i$i = $and87$i$i | $shl84$i$i;
       $I57$0$i$i = $add88$i$i;
      }
     }
     $arrayidx91$i$i = (2528 + ($I57$0$i$i<<2)|0);
     $index$i$i = ((($92)) + 28|0);
     HEAP32[$index$i$i>>2] = $I57$0$i$i;
     $arrayidx92$i$i = ((($92)) + 20|0);
     HEAP32[$arrayidx92$i$i>>2] = 0;
     HEAP32[$add$ptr81$i$i>>2] = 0;
     $152 = HEAP32[(2228)>>2]|0;
     $shl95$i$i = 1 << $I57$0$i$i;
     $and96$i$i = $152 & $shl95$i$i;
     $tobool97$i$i = ($and96$i$i|0)==(0);
     if ($tobool97$i$i) {
      $or101$i$i = $152 | $shl95$i$i;
      HEAP32[(2228)>>2] = $or101$i$i;
      HEAP32[$arrayidx91$i$i>>2] = $92;
      $parent$i$i = ((($92)) + 24|0);
      HEAP32[$parent$i$i>>2] = $arrayidx91$i$i;
      $bk102$i$i = ((($92)) + 12|0);
      HEAP32[$bk102$i$i>>2] = $92;
      $fd103$i$i = ((($92)) + 8|0);
      HEAP32[$fd103$i$i>>2] = $92;
      break;
     }
     $153 = HEAP32[$arrayidx91$i$i>>2]|0;
     $head1186$i$i = ((($153)) + 4|0);
     $154 = HEAP32[$head1186$i$i>>2]|0;
     $and1197$i$i = $154 & -8;
     $cmp1208$i$i = ($and1197$i$i|0)==($sub$ptr$sub$i$i|0);
     L325: do {
      if ($cmp1208$i$i) {
       $T$0$lcssa$i$i = $153;
      } else {
       $cmp106$i$i = ($I57$0$i$i|0)==(31);
       $shr110$i$i = $I57$0$i$i >>> 1;
       $sub113$i$i = (25 - ($shr110$i$i))|0;
       $cond115$i$i = $cmp106$i$i ? 0 : $sub113$i$i;
       $shl116$i$i = $sub$ptr$sub$i$i << $cond115$i$i;
       $K105$010$i$i = $shl116$i$i;$T$09$i$i = $153;
       while(1) {
        $shr124$i$i = $K105$010$i$i >>> 31;
        $arrayidx126$i$i = (((($T$09$i$i)) + 16|0) + ($shr124$i$i<<2)|0);
        $155 = HEAP32[$arrayidx126$i$i>>2]|0;
        $cmp128$i$i = ($155|0)==(0|0);
        if ($cmp128$i$i) {
         break;
        }
        $shl127$i$i = $K105$010$i$i << 1;
        $head118$i$i = ((($155)) + 4|0);
        $156 = HEAP32[$head118$i$i>>2]|0;
        $and119$i$i = $156 & -8;
        $cmp120$i$i = ($and119$i$i|0)==($sub$ptr$sub$i$i|0);
        if ($cmp120$i$i) {
         $T$0$lcssa$i$i = $155;
         break L325;
        } else {
         $K105$010$i$i = $shl127$i$i;$T$09$i$i = $155;
        }
       }
       HEAP32[$arrayidx126$i$i>>2] = $92;
       $parent138$i$i = ((($92)) + 24|0);
       HEAP32[$parent138$i$i>>2] = $T$09$i$i;
       $bk139$i$i = ((($92)) + 12|0);
       HEAP32[$bk139$i$i>>2] = $92;
       $fd140$i$i = ((($92)) + 8|0);
       HEAP32[$fd140$i$i>>2] = $92;
       break L215;
      }
     } while(0);
     $fd148$i$i = ((($T$0$lcssa$i$i)) + 8|0);
     $157 = HEAP32[$fd148$i$i>>2]|0;
     $bk158$i$i = ((($157)) + 12|0);
     HEAP32[$bk158$i$i>>2] = $92;
     HEAP32[$fd148$i$i>>2] = $92;
     $fd160$i$i = ((($92)) + 8|0);
     HEAP32[$fd160$i$i>>2] = $157;
     $bk161$i$i = ((($92)) + 12|0);
     HEAP32[$bk161$i$i>>2] = $T$0$lcssa$i$i;
     $parent162$i$i = ((($92)) + 24|0);
     HEAP32[$parent162$i$i>>2] = 0;
    }
   }
  } while(0);
  $158 = HEAP32[(2236)>>2]|0;
  $cmp257$i = ($158>>>0)>($nb$0>>>0);
  if ($cmp257$i) {
   $sub260$i = (($158) - ($nb$0))|0;
   HEAP32[(2236)>>2] = $sub260$i;
   $159 = HEAP32[(2248)>>2]|0;
   $add$ptr262$i = (($159) + ($nb$0)|0);
   HEAP32[(2248)>>2] = $add$ptr262$i;
   $or264$i = $sub260$i | 1;
   $head265$i = ((($add$ptr262$i)) + 4|0);
   HEAP32[$head265$i>>2] = $or264$i;
   $or267$i = $nb$0 | 3;
   $head268$i = ((($159)) + 4|0);
   HEAP32[$head268$i>>2] = $or267$i;
   $add$ptr269$i = ((($159)) + 8|0);
   $retval$0 = $add$ptr269$i;
   STACKTOP = sp;return ($retval$0|0);
  }
 }
 $call275$i = (___errno_location()|0);
 HEAP32[$call275$i>>2] = 12;
 $retval$0 = 0;
 STACKTOP = sp;return ($retval$0|0);
}
function _free($mem) {
 $mem = $mem|0;
 var $$pre = 0, $$pre$phiZ2D = 0, $0 = 0, $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0;
 var $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0;
 var $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $F510$0 = 0, $I534$0 = 0, $K583$0266 = 0;
 var $R$1 = 0, $R$1$be = 0, $R$1$ph = 0, $R$3 = 0, $R332$1 = 0, $R332$1$be = 0, $R332$1$ph = 0, $R332$3 = 0, $RP$1 = 0, $RP$1$be = 0, $RP$1$ph = 0, $RP360$1 = 0, $RP360$1$be = 0, $RP360$1$ph = 0, $T$0$lcssa = 0, $T$0265 = 0, $add$ptr = 0, $add$ptr16 = 0, $add$ptr217 = 0, $add$ptr261 = 0;
 var $add$ptr482 = 0, $add$ptr498 = 0, $add$ptr6 = 0, $add17 = 0, $add246 = 0, $add258 = 0, $add267 = 0, $add550 = 0, $add555 = 0, $add559 = 0, $add561 = 0, $add564 = 0, $and12 = 0, $and140 = 0, $and210 = 0, $and215 = 0, $and232 = 0, $and240 = 0, $and266 = 0, $and301 = 0;
 var $and410 = 0, $and46 = 0, $and495 = 0, $and5 = 0, $and512 = 0, $and545 = 0, $and549 = 0, $and554 = 0, $and563 = 0, $and574 = 0, $and592 = 0, $and592263 = 0, $and8 = 0, $arrayidx108 = 0, $arrayidx113 = 0, $arrayidx130 = 0, $arrayidx149 = 0, $arrayidx157 = 0, $arrayidx157$sink = 0, $arrayidx182 = 0;
 var $arrayidx188 = 0, $arrayidx198 = 0, $arrayidx362 = 0, $arrayidx374 = 0, $arrayidx379 = 0, $arrayidx400 = 0, $arrayidx419 = 0, $arrayidx427 = 0, $arrayidx427$sink = 0, $arrayidx454 = 0, $arrayidx460 = 0, $arrayidx470 = 0, $arrayidx509 = 0, $arrayidx567 = 0, $arrayidx570 = 0, $arrayidx599 = 0, $arrayidx99 = 0, $bk = 0, $bk275 = 0, $bk321 = 0;
 var $bk333 = 0, $bk355 = 0, $bk529 = 0, $bk531 = 0, $bk580 = 0, $bk611 = 0, $bk631 = 0, $bk634 = 0, $bk66 = 0, $bk73 = 0, $bk94 = 0, $child = 0, $child171 = 0, $child361 = 0, $child443 = 0, $child569 = 0, $cmp = 0, $cmp$i = 0, $cmp100 = 0, $cmp104 = 0;
 var $cmp109 = 0, $cmp114 = 0, $cmp127 = 0, $cmp13 = 0, $cmp131 = 0, $cmp150 = 0, $cmp162 = 0, $cmp173 = 0, $cmp18 = 0, $cmp189 = 0, $cmp211 = 0, $cmp22 = 0, $cmp228 = 0, $cmp243 = 0, $cmp249 = 0, $cmp25 = 0, $cmp255 = 0, $cmp269 = 0, $cmp296 = 0, $cmp334 = 0;
 var $cmp363 = 0, $cmp368 = 0, $cmp375 = 0, $cmp380 = 0, $cmp395 = 0, $cmp401 = 0, $cmp42 = 0, $cmp420 = 0, $cmp432 = 0, $cmp445 = 0, $cmp461 = 0, $cmp484 = 0, $cmp502 = 0, $cmp536 = 0, $cmp540 = 0, $cmp584 = 0, $cmp593 = 0, $cmp593264 = 0, $cmp601 = 0, $cmp640 = 0;
 var $cmp74 = 0, $cond = 0, $cond254 = 0, $cond255 = 0, $dec = 0, $fd = 0, $fd273 = 0, $fd322 = 0, $fd338 = 0, $fd356 = 0, $fd530 = 0, $fd581 = 0, $fd612 = 0, $fd620 = 0, $fd633 = 0, $fd67 = 0, $fd78 = 0, $fd95 = 0, $head209 = 0, $head216 = 0;
 var $head231 = 0, $head248 = 0, $head260 = 0, $head4 = 0, $head481 = 0, $head497 = 0, $head591 = 0, $head591262 = 0, $idx$neg = 0, $index = 0, $index399 = 0, $index568 = 0, $neg = 0, $neg139 = 0, $neg300 = 0, $neg409 = 0, $next4$i = 0, $or = 0, $or247 = 0, $or259 = 0;
 var $or480 = 0, $or496 = 0, $or516 = 0, $or578 = 0, $p$1 = 0, $parent = 0, $parent170 = 0, $parent183 = 0, $parent199 = 0, $parent331 = 0, $parent442 = 0, $parent455 = 0, $parent471 = 0, $parent579 = 0, $parent610 = 0, $parent635 = 0, $psize$1 = 0, $psize$2 = 0, $shl138 = 0, $shl299 = 0;
 var $shl408 = 0, $shl45 = 0, $shl508 = 0, $shl511 = 0, $shl546 = 0, $shl551 = 0, $shl557 = 0, $shl560 = 0, $shl573 = 0, $shl590 = 0, $shl600 = 0, $shr = 0, $shr268 = 0, $shr501 = 0, $shr535 = 0, $shr544 = 0, $shr548 = 0, $shr553 = 0, $shr558 = 0, $shr562 = 0;
 var $shr586 = 0, $shr597 = 0, $sp$0$i = 0, $sp$0$in$i = 0, $sub = 0, $sub547 = 0, $sub552 = 0, $sub556 = 0, $sub589 = 0, $tobool233 = 0, $tobool241 = 0, $tobool513 = 0, $tobool575 = 0, $tobool9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $cmp = ($mem|0)==(0|0);
 if ($cmp) {
  return;
 }
 $add$ptr = ((($mem)) + -8|0);
 $0 = HEAP32[(2240)>>2]|0;
 $head4 = ((($mem)) + -4|0);
 $1 = HEAP32[$head4>>2]|0;
 $and5 = $1 & -8;
 $add$ptr6 = (($add$ptr) + ($and5)|0);
 $and8 = $1 & 1;
 $tobool9 = ($and8|0)==(0);
 do {
  if ($tobool9) {
   $2 = HEAP32[$add$ptr>>2]|0;
   $and12 = $1 & 3;
   $cmp13 = ($and12|0)==(0);
   if ($cmp13) {
    return;
   }
   $idx$neg = (0 - ($2))|0;
   $add$ptr16 = (($add$ptr) + ($idx$neg)|0);
   $add17 = (($2) + ($and5))|0;
   $cmp18 = ($add$ptr16>>>0)<($0>>>0);
   if ($cmp18) {
    return;
   }
   $3 = HEAP32[(2244)>>2]|0;
   $cmp22 = ($3|0)==($add$ptr16|0);
   if ($cmp22) {
    $head209 = ((($add$ptr6)) + 4|0);
    $20 = HEAP32[$head209>>2]|0;
    $and210 = $20 & 3;
    $cmp211 = ($and210|0)==(3);
    if (!($cmp211)) {
     $21 = $add$ptr16;$p$1 = $add$ptr16;$psize$1 = $add17;
     break;
    }
    $add$ptr217 = (($add$ptr16) + ($add17)|0);
    $head216 = ((($add$ptr16)) + 4|0);
    $or = $add17 | 1;
    $and215 = $20 & -2;
    HEAP32[(2232)>>2] = $add17;
    HEAP32[$head209>>2] = $and215;
    HEAP32[$head216>>2] = $or;
    HEAP32[$add$ptr217>>2] = $add17;
    return;
   }
   $shr = $2 >>> 3;
   $cmp25 = ($2>>>0)<(256);
   if ($cmp25) {
    $fd = ((($add$ptr16)) + 8|0);
    $4 = HEAP32[$fd>>2]|0;
    $bk = ((($add$ptr16)) + 12|0);
    $5 = HEAP32[$bk>>2]|0;
    $cmp42 = ($5|0)==($4|0);
    if ($cmp42) {
     $shl45 = 1 << $shr;
     $neg = $shl45 ^ -1;
     $6 = HEAP32[556]|0;
     $and46 = $6 & $neg;
     HEAP32[556] = $and46;
     $21 = $add$ptr16;$p$1 = $add$ptr16;$psize$1 = $add17;
     break;
    } else {
     $bk66 = ((($4)) + 12|0);
     HEAP32[$bk66>>2] = $5;
     $fd67 = ((($5)) + 8|0);
     HEAP32[$fd67>>2] = $4;
     $21 = $add$ptr16;$p$1 = $add$ptr16;$psize$1 = $add17;
     break;
    }
   }
   $parent = ((($add$ptr16)) + 24|0);
   $7 = HEAP32[$parent>>2]|0;
   $bk73 = ((($add$ptr16)) + 12|0);
   $8 = HEAP32[$bk73>>2]|0;
   $cmp74 = ($8|0)==($add$ptr16|0);
   do {
    if ($cmp74) {
     $child = ((($add$ptr16)) + 16|0);
     $arrayidx99 = ((($child)) + 4|0);
     $10 = HEAP32[$arrayidx99>>2]|0;
     $cmp100 = ($10|0)==(0|0);
     if ($cmp100) {
      $11 = HEAP32[$child>>2]|0;
      $cmp104 = ($11|0)==(0|0);
      if ($cmp104) {
       $R$3 = 0;
       break;
      } else {
       $R$1$ph = $11;$RP$1$ph = $child;
      }
     } else {
      $R$1$ph = $10;$RP$1$ph = $arrayidx99;
     }
     $R$1 = $R$1$ph;$RP$1 = $RP$1$ph;
     while(1) {
      $arrayidx108 = ((($R$1)) + 20|0);
      $12 = HEAP32[$arrayidx108>>2]|0;
      $cmp109 = ($12|0)==(0|0);
      if ($cmp109) {
       $arrayidx113 = ((($R$1)) + 16|0);
       $13 = HEAP32[$arrayidx113>>2]|0;
       $cmp114 = ($13|0)==(0|0);
       if ($cmp114) {
        break;
       } else {
        $R$1$be = $13;$RP$1$be = $arrayidx113;
       }
      } else {
       $R$1$be = $12;$RP$1$be = $arrayidx108;
      }
      $R$1 = $R$1$be;$RP$1 = $RP$1$be;
     }
     HEAP32[$RP$1>>2] = 0;
     $R$3 = $R$1;
    } else {
     $fd78 = ((($add$ptr16)) + 8|0);
     $9 = HEAP32[$fd78>>2]|0;
     $bk94 = ((($9)) + 12|0);
     HEAP32[$bk94>>2] = $8;
     $fd95 = ((($8)) + 8|0);
     HEAP32[$fd95>>2] = $9;
     $R$3 = $8;
    }
   } while(0);
   $cmp127 = ($7|0)==(0|0);
   if ($cmp127) {
    $21 = $add$ptr16;$p$1 = $add$ptr16;$psize$1 = $add17;
   } else {
    $index = ((($add$ptr16)) + 28|0);
    $14 = HEAP32[$index>>2]|0;
    $arrayidx130 = (2528 + ($14<<2)|0);
    $15 = HEAP32[$arrayidx130>>2]|0;
    $cmp131 = ($15|0)==($add$ptr16|0);
    if ($cmp131) {
     HEAP32[$arrayidx130>>2] = $R$3;
     $cond254 = ($R$3|0)==(0|0);
     if ($cond254) {
      $shl138 = 1 << $14;
      $neg139 = $shl138 ^ -1;
      $16 = HEAP32[(2228)>>2]|0;
      $and140 = $16 & $neg139;
      HEAP32[(2228)>>2] = $and140;
      $21 = $add$ptr16;$p$1 = $add$ptr16;$psize$1 = $add17;
      break;
     }
    } else {
     $arrayidx149 = ((($7)) + 16|0);
     $17 = HEAP32[$arrayidx149>>2]|0;
     $cmp150 = ($17|0)==($add$ptr16|0);
     $arrayidx157 = ((($7)) + 20|0);
     $arrayidx157$sink = $cmp150 ? $arrayidx149 : $arrayidx157;
     HEAP32[$arrayidx157$sink>>2] = $R$3;
     $cmp162 = ($R$3|0)==(0|0);
     if ($cmp162) {
      $21 = $add$ptr16;$p$1 = $add$ptr16;$psize$1 = $add17;
      break;
     }
    }
    $parent170 = ((($R$3)) + 24|0);
    HEAP32[$parent170>>2] = $7;
    $child171 = ((($add$ptr16)) + 16|0);
    $18 = HEAP32[$child171>>2]|0;
    $cmp173 = ($18|0)==(0|0);
    if (!($cmp173)) {
     $arrayidx182 = ((($R$3)) + 16|0);
     HEAP32[$arrayidx182>>2] = $18;
     $parent183 = ((($18)) + 24|0);
     HEAP32[$parent183>>2] = $R$3;
    }
    $arrayidx188 = ((($child171)) + 4|0);
    $19 = HEAP32[$arrayidx188>>2]|0;
    $cmp189 = ($19|0)==(0|0);
    if ($cmp189) {
     $21 = $add$ptr16;$p$1 = $add$ptr16;$psize$1 = $add17;
    } else {
     $arrayidx198 = ((($R$3)) + 20|0);
     HEAP32[$arrayidx198>>2] = $19;
     $parent199 = ((($19)) + 24|0);
     HEAP32[$parent199>>2] = $R$3;
     $21 = $add$ptr16;$p$1 = $add$ptr16;$psize$1 = $add17;
    }
   }
  } else {
   $21 = $add$ptr;$p$1 = $add$ptr;$psize$1 = $and5;
  }
 } while(0);
 $cmp228 = ($21>>>0)<($add$ptr6>>>0);
 if (!($cmp228)) {
  return;
 }
 $head231 = ((($add$ptr6)) + 4|0);
 $22 = HEAP32[$head231>>2]|0;
 $and232 = $22 & 1;
 $tobool233 = ($and232|0)==(0);
 if ($tobool233) {
  return;
 }
 $and240 = $22 & 2;
 $tobool241 = ($and240|0)==(0);
 if ($tobool241) {
  $23 = HEAP32[(2248)>>2]|0;
  $cmp243 = ($23|0)==($add$ptr6|0);
  if ($cmp243) {
   $24 = HEAP32[(2236)>>2]|0;
   $add246 = (($24) + ($psize$1))|0;
   HEAP32[(2236)>>2] = $add246;
   HEAP32[(2248)>>2] = $p$1;
   $or247 = $add246 | 1;
   $head248 = ((($p$1)) + 4|0);
   HEAP32[$head248>>2] = $or247;
   $25 = HEAP32[(2244)>>2]|0;
   $cmp249 = ($p$1|0)==($25|0);
   if (!($cmp249)) {
    return;
   }
   HEAP32[(2244)>>2] = 0;
   HEAP32[(2232)>>2] = 0;
   return;
  }
  $26 = HEAP32[(2244)>>2]|0;
  $cmp255 = ($26|0)==($add$ptr6|0);
  if ($cmp255) {
   $27 = HEAP32[(2232)>>2]|0;
   $add258 = (($27) + ($psize$1))|0;
   HEAP32[(2232)>>2] = $add258;
   HEAP32[(2244)>>2] = $21;
   $or259 = $add258 | 1;
   $head260 = ((($p$1)) + 4|0);
   HEAP32[$head260>>2] = $or259;
   $add$ptr261 = (($21) + ($add258)|0);
   HEAP32[$add$ptr261>>2] = $add258;
   return;
  }
  $and266 = $22 & -8;
  $add267 = (($and266) + ($psize$1))|0;
  $shr268 = $22 >>> 3;
  $cmp269 = ($22>>>0)<(256);
  do {
   if ($cmp269) {
    $fd273 = ((($add$ptr6)) + 8|0);
    $28 = HEAP32[$fd273>>2]|0;
    $bk275 = ((($add$ptr6)) + 12|0);
    $29 = HEAP32[$bk275>>2]|0;
    $cmp296 = ($29|0)==($28|0);
    if ($cmp296) {
     $shl299 = 1 << $shr268;
     $neg300 = $shl299 ^ -1;
     $30 = HEAP32[556]|0;
     $and301 = $30 & $neg300;
     HEAP32[556] = $and301;
     break;
    } else {
     $bk321 = ((($28)) + 12|0);
     HEAP32[$bk321>>2] = $29;
     $fd322 = ((($29)) + 8|0);
     HEAP32[$fd322>>2] = $28;
     break;
    }
   } else {
    $parent331 = ((($add$ptr6)) + 24|0);
    $31 = HEAP32[$parent331>>2]|0;
    $bk333 = ((($add$ptr6)) + 12|0);
    $32 = HEAP32[$bk333>>2]|0;
    $cmp334 = ($32|0)==($add$ptr6|0);
    do {
     if ($cmp334) {
      $child361 = ((($add$ptr6)) + 16|0);
      $arrayidx362 = ((($child361)) + 4|0);
      $34 = HEAP32[$arrayidx362>>2]|0;
      $cmp363 = ($34|0)==(0|0);
      if ($cmp363) {
       $35 = HEAP32[$child361>>2]|0;
       $cmp368 = ($35|0)==(0|0);
       if ($cmp368) {
        $R332$3 = 0;
        break;
       } else {
        $R332$1$ph = $35;$RP360$1$ph = $child361;
       }
      } else {
       $R332$1$ph = $34;$RP360$1$ph = $arrayidx362;
      }
      $R332$1 = $R332$1$ph;$RP360$1 = $RP360$1$ph;
      while(1) {
       $arrayidx374 = ((($R332$1)) + 20|0);
       $36 = HEAP32[$arrayidx374>>2]|0;
       $cmp375 = ($36|0)==(0|0);
       if ($cmp375) {
        $arrayidx379 = ((($R332$1)) + 16|0);
        $37 = HEAP32[$arrayidx379>>2]|0;
        $cmp380 = ($37|0)==(0|0);
        if ($cmp380) {
         break;
        } else {
         $R332$1$be = $37;$RP360$1$be = $arrayidx379;
        }
       } else {
        $R332$1$be = $36;$RP360$1$be = $arrayidx374;
       }
       $R332$1 = $R332$1$be;$RP360$1 = $RP360$1$be;
      }
      HEAP32[$RP360$1>>2] = 0;
      $R332$3 = $R332$1;
     } else {
      $fd338 = ((($add$ptr6)) + 8|0);
      $33 = HEAP32[$fd338>>2]|0;
      $bk355 = ((($33)) + 12|0);
      HEAP32[$bk355>>2] = $32;
      $fd356 = ((($32)) + 8|0);
      HEAP32[$fd356>>2] = $33;
      $R332$3 = $32;
     }
    } while(0);
    $cmp395 = ($31|0)==(0|0);
    if (!($cmp395)) {
     $index399 = ((($add$ptr6)) + 28|0);
     $38 = HEAP32[$index399>>2]|0;
     $arrayidx400 = (2528 + ($38<<2)|0);
     $39 = HEAP32[$arrayidx400>>2]|0;
     $cmp401 = ($39|0)==($add$ptr6|0);
     if ($cmp401) {
      HEAP32[$arrayidx400>>2] = $R332$3;
      $cond255 = ($R332$3|0)==(0|0);
      if ($cond255) {
       $shl408 = 1 << $38;
       $neg409 = $shl408 ^ -1;
       $40 = HEAP32[(2228)>>2]|0;
       $and410 = $40 & $neg409;
       HEAP32[(2228)>>2] = $and410;
       break;
      }
     } else {
      $arrayidx419 = ((($31)) + 16|0);
      $41 = HEAP32[$arrayidx419>>2]|0;
      $cmp420 = ($41|0)==($add$ptr6|0);
      $arrayidx427 = ((($31)) + 20|0);
      $arrayidx427$sink = $cmp420 ? $arrayidx419 : $arrayidx427;
      HEAP32[$arrayidx427$sink>>2] = $R332$3;
      $cmp432 = ($R332$3|0)==(0|0);
      if ($cmp432) {
       break;
      }
     }
     $parent442 = ((($R332$3)) + 24|0);
     HEAP32[$parent442>>2] = $31;
     $child443 = ((($add$ptr6)) + 16|0);
     $42 = HEAP32[$child443>>2]|0;
     $cmp445 = ($42|0)==(0|0);
     if (!($cmp445)) {
      $arrayidx454 = ((($R332$3)) + 16|0);
      HEAP32[$arrayidx454>>2] = $42;
      $parent455 = ((($42)) + 24|0);
      HEAP32[$parent455>>2] = $R332$3;
     }
     $arrayidx460 = ((($child443)) + 4|0);
     $43 = HEAP32[$arrayidx460>>2]|0;
     $cmp461 = ($43|0)==(0|0);
     if (!($cmp461)) {
      $arrayidx470 = ((($R332$3)) + 20|0);
      HEAP32[$arrayidx470>>2] = $43;
      $parent471 = ((($43)) + 24|0);
      HEAP32[$parent471>>2] = $R332$3;
     }
    }
   }
  } while(0);
  $or480 = $add267 | 1;
  $head481 = ((($p$1)) + 4|0);
  HEAP32[$head481>>2] = $or480;
  $add$ptr482 = (($21) + ($add267)|0);
  HEAP32[$add$ptr482>>2] = $add267;
  $44 = HEAP32[(2244)>>2]|0;
  $cmp484 = ($p$1|0)==($44|0);
  if ($cmp484) {
   HEAP32[(2232)>>2] = $add267;
   return;
  } else {
   $psize$2 = $add267;
  }
 } else {
  $and495 = $22 & -2;
  HEAP32[$head231>>2] = $and495;
  $or496 = $psize$1 | 1;
  $head497 = ((($p$1)) + 4|0);
  HEAP32[$head497>>2] = $or496;
  $add$ptr498 = (($21) + ($psize$1)|0);
  HEAP32[$add$ptr498>>2] = $psize$1;
  $psize$2 = $psize$1;
 }
 $shr501 = $psize$2 >>> 3;
 $cmp502 = ($psize$2>>>0)<(256);
 if ($cmp502) {
  $shl508 = $shr501 << 1;
  $arrayidx509 = (2264 + ($shl508<<2)|0);
  $45 = HEAP32[556]|0;
  $shl511 = 1 << $shr501;
  $and512 = $45 & $shl511;
  $tobool513 = ($and512|0)==(0);
  if ($tobool513) {
   $or516 = $45 | $shl511;
   HEAP32[556] = $or516;
   $$pre = ((($arrayidx509)) + 8|0);
   $$pre$phiZ2D = $$pre;$F510$0 = $arrayidx509;
  } else {
   $46 = ((($arrayidx509)) + 8|0);
   $47 = HEAP32[$46>>2]|0;
   $$pre$phiZ2D = $46;$F510$0 = $47;
  }
  HEAP32[$$pre$phiZ2D>>2] = $p$1;
  $bk529 = ((($F510$0)) + 12|0);
  HEAP32[$bk529>>2] = $p$1;
  $fd530 = ((($p$1)) + 8|0);
  HEAP32[$fd530>>2] = $F510$0;
  $bk531 = ((($p$1)) + 12|0);
  HEAP32[$bk531>>2] = $arrayidx509;
  return;
 }
 $shr535 = $psize$2 >>> 8;
 $cmp536 = ($shr535|0)==(0);
 if ($cmp536) {
  $I534$0 = 0;
 } else {
  $cmp540 = ($psize$2>>>0)>(16777215);
  if ($cmp540) {
   $I534$0 = 31;
  } else {
   $sub = (($shr535) + 1048320)|0;
   $shr544 = $sub >>> 16;
   $and545 = $shr544 & 8;
   $shl546 = $shr535 << $and545;
   $sub547 = (($shl546) + 520192)|0;
   $shr548 = $sub547 >>> 16;
   $and549 = $shr548 & 4;
   $add550 = $and549 | $and545;
   $shl551 = $shl546 << $and549;
   $sub552 = (($shl551) + 245760)|0;
   $shr553 = $sub552 >>> 16;
   $and554 = $shr553 & 2;
   $add555 = $add550 | $and554;
   $sub556 = (14 - ($add555))|0;
   $shl557 = $shl551 << $and554;
   $shr558 = $shl557 >>> 15;
   $add559 = (($sub556) + ($shr558))|0;
   $shl560 = $add559 << 1;
   $add561 = (($add559) + 7)|0;
   $shr562 = $psize$2 >>> $add561;
   $and563 = $shr562 & 1;
   $add564 = $and563 | $shl560;
   $I534$0 = $add564;
  }
 }
 $arrayidx567 = (2528 + ($I534$0<<2)|0);
 $index568 = ((($p$1)) + 28|0);
 HEAP32[$index568>>2] = $I534$0;
 $child569 = ((($p$1)) + 16|0);
 $arrayidx570 = ((($p$1)) + 20|0);
 HEAP32[$arrayidx570>>2] = 0;
 HEAP32[$child569>>2] = 0;
 $48 = HEAP32[(2228)>>2]|0;
 $shl573 = 1 << $I534$0;
 $and574 = $48 & $shl573;
 $tobool575 = ($and574|0)==(0);
 L112: do {
  if ($tobool575) {
   $or578 = $48 | $shl573;
   HEAP32[(2228)>>2] = $or578;
   HEAP32[$arrayidx567>>2] = $p$1;
   $parent579 = ((($p$1)) + 24|0);
   HEAP32[$parent579>>2] = $arrayidx567;
   $bk580 = ((($p$1)) + 12|0);
   HEAP32[$bk580>>2] = $p$1;
   $fd581 = ((($p$1)) + 8|0);
   HEAP32[$fd581>>2] = $p$1;
  } else {
   $49 = HEAP32[$arrayidx567>>2]|0;
   $head591262 = ((($49)) + 4|0);
   $50 = HEAP32[$head591262>>2]|0;
   $and592263 = $50 & -8;
   $cmp593264 = ($and592263|0)==($psize$2|0);
   L115: do {
    if ($cmp593264) {
     $T$0$lcssa = $49;
    } else {
     $cmp584 = ($I534$0|0)==(31);
     $shr586 = $I534$0 >>> 1;
     $sub589 = (25 - ($shr586))|0;
     $cond = $cmp584 ? 0 : $sub589;
     $shl590 = $psize$2 << $cond;
     $K583$0266 = $shl590;$T$0265 = $49;
     while(1) {
      $shr597 = $K583$0266 >>> 31;
      $arrayidx599 = (((($T$0265)) + 16|0) + ($shr597<<2)|0);
      $51 = HEAP32[$arrayidx599>>2]|0;
      $cmp601 = ($51|0)==(0|0);
      if ($cmp601) {
       break;
      }
      $shl600 = $K583$0266 << 1;
      $head591 = ((($51)) + 4|0);
      $52 = HEAP32[$head591>>2]|0;
      $and592 = $52 & -8;
      $cmp593 = ($and592|0)==($psize$2|0);
      if ($cmp593) {
       $T$0$lcssa = $51;
       break L115;
      } else {
       $K583$0266 = $shl600;$T$0265 = $51;
      }
     }
     HEAP32[$arrayidx599>>2] = $p$1;
     $parent610 = ((($p$1)) + 24|0);
     HEAP32[$parent610>>2] = $T$0265;
     $bk611 = ((($p$1)) + 12|0);
     HEAP32[$bk611>>2] = $p$1;
     $fd612 = ((($p$1)) + 8|0);
     HEAP32[$fd612>>2] = $p$1;
     break L112;
    }
   } while(0);
   $fd620 = ((($T$0$lcssa)) + 8|0);
   $53 = HEAP32[$fd620>>2]|0;
   $bk631 = ((($53)) + 12|0);
   HEAP32[$bk631>>2] = $p$1;
   HEAP32[$fd620>>2] = $p$1;
   $fd633 = ((($p$1)) + 8|0);
   HEAP32[$fd633>>2] = $53;
   $bk634 = ((($p$1)) + 12|0);
   HEAP32[$bk634>>2] = $T$0$lcssa;
   $parent635 = ((($p$1)) + 24|0);
   HEAP32[$parent635>>2] = 0;
  }
 } while(0);
 $54 = HEAP32[(2256)>>2]|0;
 $dec = (($54) + -1)|0;
 HEAP32[(2256)>>2] = $dec;
 $cmp640 = ($dec|0)==(0);
 if (!($cmp640)) {
  return;
 }
 $sp$0$in$i = (2680);
 while(1) {
  $sp$0$i = HEAP32[$sp$0$in$i>>2]|0;
  $cmp$i = ($sp$0$i|0)==(0|0);
  $next4$i = ((($sp$0$i)) + 8|0);
  if ($cmp$i) {
   break;
  } else {
   $sp$0$in$i = $next4$i;
  }
 }
 HEAP32[(2256)>>2] = -1;
 return;
}
function ___muldsi3($a, $b) {
    $a = $a | 0;
    $b = $b | 0;
    var $1 = 0, $2 = 0, $3 = 0, $6 = 0, $8 = 0, $11 = 0, $12 = 0;
    $1 = $a & 65535;
    $2 = $b & 65535;
    $3 = Math_imul($2, $1) | 0;
    $6 = $a >>> 16;
    $8 = ($3 >>> 16) + (Math_imul($2, $6) | 0) | 0;
    $11 = $b >>> 16;
    $12 = Math_imul($11, $1) | 0;
    return (setTempRet0(((($8 >>> 16) + (Math_imul($11, $6) | 0) | 0) + ((($8 & 65535) + $12 | 0) >>> 16) | 0) | 0), 0 | ($8 + $12 << 16 | $3 & 65535)) | 0;
}
function ___muldi3($a$0, $a$1, $b$0, $b$1) {
    $a$0 = $a$0 | 0;
    $a$1 = $a$1 | 0;
    $b$0 = $b$0 | 0;
    $b$1 = $b$1 | 0;
    var $x_sroa_0_0_extract_trunc = 0, $y_sroa_0_0_extract_trunc = 0, $1$0 = 0, $1$1 = 0, $2 = 0;
    $x_sroa_0_0_extract_trunc = $a$0;
    $y_sroa_0_0_extract_trunc = $b$0;
    $1$0 = ___muldsi3($x_sroa_0_0_extract_trunc, $y_sroa_0_0_extract_trunc) | 0;
    $1$1 = (getTempRet0() | 0);
    $2 = Math_imul($a$1, $y_sroa_0_0_extract_trunc) | 0;
    return (setTempRet0((((Math_imul($b$1, $x_sroa_0_0_extract_trunc) | 0) + $2 | 0) + $1$1 | $1$1 & 0) | 0), 0 | $1$0 & -1) | 0;
}
function _i64Add(a, b, c, d) {
    /*
      x = a + b*2^32
      y = c + d*2^32
      result = l + h*2^32
    */
    a = a|0; b = b|0; c = c|0; d = d|0;
    var l = 0, h = 0;
    l = (a + c)>>>0;
    h = (b + d + (((l>>>0) < (a>>>0))|0))>>>0; // Add carry from low word to high word on overflow.
    return ((setTempRet0((h) | 0),l|0)|0);
}
function _i64Subtract(a, b, c, d) {
    a = a|0; b = b|0; c = c|0; d = d|0;
    var l = 0, h = 0;
    l = (a - c)>>>0;
    h = (b - d)>>>0;
    h = (b - d - (((c>>>0) > (a>>>0))|0))>>>0; // Borrow one from high word to low word on underflow.
    return ((setTempRet0((h) | 0),l|0)|0);
}
function _llvm_cttz_i32(x) { // Note: Currently doesn't take isZeroUndef()
    x = x | 0;
    return (x ? (31 - (Math_clz32((x ^ (x - 1))) | 0) | 0) : 32) | 0;
}
function ___udivmoddi4($a$0, $a$1, $b$0, $b$1, $rem) {
    $a$0 = $a$0 | 0;
    $a$1 = $a$1 | 0;
    $b$0 = $b$0 | 0;
    $b$1 = $b$1 | 0;
    $rem = $rem | 0;
    var $n_sroa_0_0_extract_trunc = 0, $n_sroa_1_4_extract_shift$0 = 0, $n_sroa_1_4_extract_trunc = 0, $d_sroa_0_0_extract_trunc = 0, $d_sroa_1_4_extract_shift$0 = 0, $d_sroa_1_4_extract_trunc = 0, $4 = 0, $17 = 0, $37 = 0, $49 = 0, $51 = 0, $57 = 0, $58 = 0, $66 = 0, $78 = 0, $86 = 0, $88 = 0, $89 = 0, $91 = 0, $92 = 0, $95 = 0, $105 = 0, $117 = 0, $119 = 0, $125 = 0, $126 = 0, $130 = 0, $q_sroa_1_1_ph = 0, $q_sroa_0_1_ph = 0, $r_sroa_1_1_ph = 0, $r_sroa_0_1_ph = 0, $sr_1_ph = 0, $d_sroa_0_0_insert_insert99$0 = 0, $d_sroa_0_0_insert_insert99$1 = 0, $137$0 = 0, $137$1 = 0, $carry_0203 = 0, $sr_1202 = 0, $r_sroa_0_1201 = 0, $r_sroa_1_1200 = 0, $q_sroa_0_1199 = 0, $q_sroa_1_1198 = 0, $147 = 0, $149 = 0, $r_sroa_0_0_insert_insert42$0 = 0, $r_sroa_0_0_insert_insert42$1 = 0, $150$1 = 0, $151$0 = 0, $152 = 0, $154$0 = 0, $r_sroa_0_0_extract_trunc = 0, $r_sroa_1_4_extract_trunc = 0, $155 = 0, $carry_0_lcssa$0 = 0, $carry_0_lcssa$1 = 0, $r_sroa_0_1_lcssa = 0, $r_sroa_1_1_lcssa = 0, $q_sroa_0_1_lcssa = 0, $q_sroa_1_1_lcssa = 0, $q_sroa_0_0_insert_ext75$0 = 0, $q_sroa_0_0_insert_ext75$1 = 0, $q_sroa_0_0_insert_insert77$1 = 0, $_0$0 = 0, $_0$1 = 0;
    $n_sroa_0_0_extract_trunc = $a$0;
    $n_sroa_1_4_extract_shift$0 = $a$1;
    $n_sroa_1_4_extract_trunc = $n_sroa_1_4_extract_shift$0;
    $d_sroa_0_0_extract_trunc = $b$0;
    $d_sroa_1_4_extract_shift$0 = $b$1;
    $d_sroa_1_4_extract_trunc = $d_sroa_1_4_extract_shift$0;
    if (($n_sroa_1_4_extract_trunc | 0) == 0) {
      $4 = ($rem | 0) != 0;
      if (($d_sroa_1_4_extract_trunc | 0) == 0) {
        if ($4) {
          HEAP32[$rem >> 2] = ($n_sroa_0_0_extract_trunc >>> 0) % ($d_sroa_0_0_extract_trunc >>> 0);
          HEAP32[$rem + 4 >> 2] = 0;
        }
        $_0$1 = 0;
        $_0$0 = ($n_sroa_0_0_extract_trunc >>> 0) / ($d_sroa_0_0_extract_trunc >>> 0) >>> 0;
        return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
      } else {
        if (!$4) {
          $_0$1 = 0;
          $_0$0 = 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        HEAP32[$rem >> 2] = $a$0 & -1;
        HEAP32[$rem + 4 >> 2] = $a$1 & 0;
        $_0$1 = 0;
        $_0$0 = 0;
        return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
      }
    }
    $17 = ($d_sroa_1_4_extract_trunc | 0) == 0;
    do {
      if (($d_sroa_0_0_extract_trunc | 0) == 0) {
        if ($17) {
          if (($rem | 0) != 0) {
            HEAP32[$rem >> 2] = ($n_sroa_1_4_extract_trunc >>> 0) % ($d_sroa_0_0_extract_trunc >>> 0);
            HEAP32[$rem + 4 >> 2] = 0;
          }
          $_0$1 = 0;
          $_0$0 = ($n_sroa_1_4_extract_trunc >>> 0) / ($d_sroa_0_0_extract_trunc >>> 0) >>> 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        if (($n_sroa_0_0_extract_trunc | 0) == 0) {
          if (($rem | 0) != 0) {
            HEAP32[$rem >> 2] = 0;
            HEAP32[$rem + 4 >> 2] = ($n_sroa_1_4_extract_trunc >>> 0) % ($d_sroa_1_4_extract_trunc >>> 0);
          }
          $_0$1 = 0;
          $_0$0 = ($n_sroa_1_4_extract_trunc >>> 0) / ($d_sroa_1_4_extract_trunc >>> 0) >>> 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        $37 = $d_sroa_1_4_extract_trunc - 1 | 0;
        if (($37 & $d_sroa_1_4_extract_trunc | 0) == 0) {
          if (($rem | 0) != 0) {
            HEAP32[$rem >> 2] = 0 | $a$0 & -1;
            HEAP32[$rem + 4 >> 2] = $37 & $n_sroa_1_4_extract_trunc | $a$1 & 0;
          }
          $_0$1 = 0;
          $_0$0 = $n_sroa_1_4_extract_trunc >>> ((_llvm_cttz_i32($d_sroa_1_4_extract_trunc | 0) | 0) >>> 0);
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        $49 = Math_clz32($d_sroa_1_4_extract_trunc | 0) | 0;
        $51 = $49 - (Math_clz32($n_sroa_1_4_extract_trunc | 0) | 0) | 0;
        if ($51 >>> 0 <= 30) {
          $57 = $51 + 1 | 0;
          $58 = 31 - $51 | 0;
          $sr_1_ph = $57;
          $r_sroa_0_1_ph = $n_sroa_1_4_extract_trunc << $58 | $n_sroa_0_0_extract_trunc >>> ($57 >>> 0);
          $r_sroa_1_1_ph = $n_sroa_1_4_extract_trunc >>> ($57 >>> 0);
          $q_sroa_0_1_ph = 0;
          $q_sroa_1_1_ph = $n_sroa_0_0_extract_trunc << $58;
          break;
        }
        if (($rem | 0) == 0) {
          $_0$1 = 0;
          $_0$0 = 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        HEAP32[$rem >> 2] = 0 | $a$0 & -1;
        HEAP32[$rem + 4 >> 2] = $n_sroa_1_4_extract_shift$0 | $a$1 & 0;
        $_0$1 = 0;
        $_0$0 = 0;
        return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
      } else {
        if (!$17) {
          $117 = Math_clz32($d_sroa_1_4_extract_trunc | 0) | 0;
          $119 = $117 - (Math_clz32($n_sroa_1_4_extract_trunc | 0) | 0) | 0;
          if ($119 >>> 0 <= 31) {
            $125 = $119 + 1 | 0;
            $126 = 31 - $119 | 0;
            $130 = $119 - 31 >> 31;
            $sr_1_ph = $125;
            $r_sroa_0_1_ph = $n_sroa_0_0_extract_trunc >>> ($125 >>> 0) & $130 | $n_sroa_1_4_extract_trunc << $126;
            $r_sroa_1_1_ph = $n_sroa_1_4_extract_trunc >>> ($125 >>> 0) & $130;
            $q_sroa_0_1_ph = 0;
            $q_sroa_1_1_ph = $n_sroa_0_0_extract_trunc << $126;
            break;
          }
          if (($rem | 0) == 0) {
            $_0$1 = 0;
            $_0$0 = 0;
            return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
          }
          HEAP32[$rem >> 2] = 0 | $a$0 & -1;
          HEAP32[$rem + 4 >> 2] = $n_sroa_1_4_extract_shift$0 | $a$1 & 0;
          $_0$1 = 0;
          $_0$0 = 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        $66 = $d_sroa_0_0_extract_trunc - 1 | 0;
        if (($66 & $d_sroa_0_0_extract_trunc | 0) != 0) {
          $86 = (Math_clz32($d_sroa_0_0_extract_trunc | 0) | 0) + 33 | 0;
          $88 = $86 - (Math_clz32($n_sroa_1_4_extract_trunc | 0) | 0) | 0;
          $89 = 64 - $88 | 0;
          $91 = 32 - $88 | 0;
          $92 = $91 >> 31;
          $95 = $88 - 32 | 0;
          $105 = $95 >> 31;
          $sr_1_ph = $88;
          $r_sroa_0_1_ph = $91 - 1 >> 31 & $n_sroa_1_4_extract_trunc >>> ($95 >>> 0) | ($n_sroa_1_4_extract_trunc << $91 | $n_sroa_0_0_extract_trunc >>> ($88 >>> 0)) & $105;
          $r_sroa_1_1_ph = $105 & $n_sroa_1_4_extract_trunc >>> ($88 >>> 0);
          $q_sroa_0_1_ph = $n_sroa_0_0_extract_trunc << $89 & $92;
          $q_sroa_1_1_ph = ($n_sroa_1_4_extract_trunc << $89 | $n_sroa_0_0_extract_trunc >>> ($95 >>> 0)) & $92 | $n_sroa_0_0_extract_trunc << $91 & $88 - 33 >> 31;
          break;
        }
        if (($rem | 0) != 0) {
          HEAP32[$rem >> 2] = $66 & $n_sroa_0_0_extract_trunc;
          HEAP32[$rem + 4 >> 2] = 0;
        }
        if (($d_sroa_0_0_extract_trunc | 0) == 1) {
          $_0$1 = $n_sroa_1_4_extract_shift$0 | $a$1 & 0;
          $_0$0 = 0 | $a$0 & -1;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        } else {
          $78 = _llvm_cttz_i32($d_sroa_0_0_extract_trunc | 0) | 0;
          $_0$1 = 0 | $n_sroa_1_4_extract_trunc >>> ($78 >>> 0);
          $_0$0 = $n_sroa_1_4_extract_trunc << 32 - $78 | $n_sroa_0_0_extract_trunc >>> ($78 >>> 0) | 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
      }
    } while (0);
    if (($sr_1_ph | 0) == 0) {
      $q_sroa_1_1_lcssa = $q_sroa_1_1_ph;
      $q_sroa_0_1_lcssa = $q_sroa_0_1_ph;
      $r_sroa_1_1_lcssa = $r_sroa_1_1_ph;
      $r_sroa_0_1_lcssa = $r_sroa_0_1_ph;
      $carry_0_lcssa$1 = 0;
      $carry_0_lcssa$0 = 0;
    } else {
      $d_sroa_0_0_insert_insert99$0 = 0 | $b$0 & -1;
      $d_sroa_0_0_insert_insert99$1 = $d_sroa_1_4_extract_shift$0 | $b$1 & 0;
      $137$0 = _i64Add($d_sroa_0_0_insert_insert99$0 | 0, $d_sroa_0_0_insert_insert99$1 | 0, -1, -1) | 0;
      $137$1 = (getTempRet0() | 0);
      $q_sroa_1_1198 = $q_sroa_1_1_ph;
      $q_sroa_0_1199 = $q_sroa_0_1_ph;
      $r_sroa_1_1200 = $r_sroa_1_1_ph;
      $r_sroa_0_1201 = $r_sroa_0_1_ph;
      $sr_1202 = $sr_1_ph;
      $carry_0203 = 0;
      while (1) {
        $147 = $q_sroa_0_1199 >>> 31 | $q_sroa_1_1198 << 1;
        $149 = $carry_0203 | $q_sroa_0_1199 << 1;
        $r_sroa_0_0_insert_insert42$0 = 0 | ($r_sroa_0_1201 << 1 | $q_sroa_1_1198 >>> 31);
        $r_sroa_0_0_insert_insert42$1 = $r_sroa_0_1201 >>> 31 | $r_sroa_1_1200 << 1 | 0;
        _i64Subtract($137$0 | 0, $137$1 | 0, $r_sroa_0_0_insert_insert42$0 | 0, $r_sroa_0_0_insert_insert42$1 | 0) | 0;
        $150$1 = (getTempRet0() | 0);
        $151$0 = $150$1 >> 31 | (($150$1 | 0) < 0 ? -1 : 0) << 1;
        $152 = $151$0 & 1;
        $154$0 = _i64Subtract($r_sroa_0_0_insert_insert42$0 | 0, $r_sroa_0_0_insert_insert42$1 | 0, $151$0 & $d_sroa_0_0_insert_insert99$0 | 0, ((($150$1 | 0) < 0 ? -1 : 0) >> 31 | (($150$1 | 0) < 0 ? -1 : 0) << 1) & $d_sroa_0_0_insert_insert99$1 | 0) | 0;
        $r_sroa_0_0_extract_trunc = $154$0;
        $r_sroa_1_4_extract_trunc = (getTempRet0() | 0);
        $155 = $sr_1202 - 1 | 0;
        if (($155 | 0) == 0) {
          break;
        } else {
          $q_sroa_1_1198 = $147;
          $q_sroa_0_1199 = $149;
          $r_sroa_1_1200 = $r_sroa_1_4_extract_trunc;
          $r_sroa_0_1201 = $r_sroa_0_0_extract_trunc;
          $sr_1202 = $155;
          $carry_0203 = $152;
        }
      }
      $q_sroa_1_1_lcssa = $147;
      $q_sroa_0_1_lcssa = $149;
      $r_sroa_1_1_lcssa = $r_sroa_1_4_extract_trunc;
      $r_sroa_0_1_lcssa = $r_sroa_0_0_extract_trunc;
      $carry_0_lcssa$1 = 0;
      $carry_0_lcssa$0 = $152;
    }
    $q_sroa_0_0_insert_ext75$0 = $q_sroa_0_1_lcssa;
    $q_sroa_0_0_insert_ext75$1 = 0;
    $q_sroa_0_0_insert_insert77$1 = $q_sroa_1_1_lcssa | $q_sroa_0_0_insert_ext75$1;
    if (($rem | 0) != 0) {
      HEAP32[$rem >> 2] = 0 | $r_sroa_0_1_lcssa;
      HEAP32[$rem + 4 >> 2] = $r_sroa_1_1_lcssa | 0;
    }
    $_0$1 = (0 | $q_sroa_0_0_insert_ext75$0) >>> 31 | $q_sroa_0_0_insert_insert77$1 << 1 | ($q_sroa_0_0_insert_ext75$1 << 1 | $q_sroa_0_0_insert_ext75$0 >>> 31) & 0 | $carry_0_lcssa$1;
    $_0$0 = ($q_sroa_0_0_insert_ext75$0 << 1 | 0 >>> 31) & -2 | $carry_0_lcssa$0;
    return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
}
function ___udivdi3($a$0, $a$1, $b$0, $b$1) {
    $a$0 = $a$0 | 0;
    $a$1 = $a$1 | 0;
    $b$0 = $b$0 | 0;
    $b$1 = $b$1 | 0;
    var $1$0 = 0;
    $1$0 = ___udivmoddi4($a$0, $a$1, $b$0, $b$1, 0) | 0;
    return $1$0 | 0;
}
function _bitshift64Lshr(low, high, bits) {
    low = low|0; high = high|0; bits = bits|0;
    var ander = 0;
    if ((bits|0) < 32) {
      ander = ((1 << bits) - 1)|0;
      setTempRet0((high >>> bits) | 0);
      return (low >>> bits) | ((high&ander) << (32 - bits));
    }
    setTempRet0((0) | 0);
    return (high >>> (bits - 32))|0;
}
function _bitshift64Shl(low, high, bits) {
    low = low|0; high = high|0; bits = bits|0;
    var ander = 0;
    if ((bits|0) < 32) {
      ander = ((1 << bits) - 1)|0;
      setTempRet0(((high << bits) | ((low&(ander << (32 - bits))) >>> (32 - bits))) | 0);
      return low << bits;
    }
    setTempRet0((low << (bits - 32)) | 0);
    return 0;
}
function _memcpy(dest, src, num) {
    dest = dest|0; src = src|0; num = num|0;
    var ret = 0;
    var aligned_dest_end = 0;
    var block_aligned_dest_end = 0;
    var dest_end = 0;
    // Test against a benchmarked cutoff limit for when HEAPU8.set() becomes faster to use.
    if ((num|0) >= 8192) {
      _emscripten_memcpy_big(dest|0, src|0, num|0)|0;
      return dest|0;
    }

    ret = dest|0;
    dest_end = (dest + num)|0;
    if ((dest&3) == (src&3)) {
      // The initial unaligned < 4-byte front.
      while (dest & 3) {
        if ((num|0) == 0) return ret|0;
        HEAP8[((dest)>>0)]=((HEAP8[((src)>>0)])|0);
        dest = (dest+1)|0;
        src = (src+1)|0;
        num = (num-1)|0;
      }
      aligned_dest_end = (dest_end & -4)|0;
      block_aligned_dest_end = (aligned_dest_end - 64)|0;
      while ((dest|0) <= (block_aligned_dest_end|0) ) {
        HEAP32[((dest)>>2)]=((HEAP32[((src)>>2)])|0);
        HEAP32[(((dest)+(4))>>2)]=((HEAP32[(((src)+(4))>>2)])|0);
        HEAP32[(((dest)+(8))>>2)]=((HEAP32[(((src)+(8))>>2)])|0);
        HEAP32[(((dest)+(12))>>2)]=((HEAP32[(((src)+(12))>>2)])|0);
        HEAP32[(((dest)+(16))>>2)]=((HEAP32[(((src)+(16))>>2)])|0);
        HEAP32[(((dest)+(20))>>2)]=((HEAP32[(((src)+(20))>>2)])|0);
        HEAP32[(((dest)+(24))>>2)]=((HEAP32[(((src)+(24))>>2)])|0);
        HEAP32[(((dest)+(28))>>2)]=((HEAP32[(((src)+(28))>>2)])|0);
        HEAP32[(((dest)+(32))>>2)]=((HEAP32[(((src)+(32))>>2)])|0);
        HEAP32[(((dest)+(36))>>2)]=((HEAP32[(((src)+(36))>>2)])|0);
        HEAP32[(((dest)+(40))>>2)]=((HEAP32[(((src)+(40))>>2)])|0);
        HEAP32[(((dest)+(44))>>2)]=((HEAP32[(((src)+(44))>>2)])|0);
        HEAP32[(((dest)+(48))>>2)]=((HEAP32[(((src)+(48))>>2)])|0);
        HEAP32[(((dest)+(52))>>2)]=((HEAP32[(((src)+(52))>>2)])|0);
        HEAP32[(((dest)+(56))>>2)]=((HEAP32[(((src)+(56))>>2)])|0);
        HEAP32[(((dest)+(60))>>2)]=((HEAP32[(((src)+(60))>>2)])|0);
        dest = (dest+64)|0;
        src = (src+64)|0;
      }
      while ((dest|0) < (aligned_dest_end|0) ) {
        HEAP32[((dest)>>2)]=((HEAP32[((src)>>2)])|0);
        dest = (dest+4)|0;
        src = (src+4)|0;
      }
    } else {
      // In the unaligned copy case, unroll a bit as well.
      aligned_dest_end = (dest_end - 4)|0;
      while ((dest|0) < (aligned_dest_end|0) ) {
        HEAP8[((dest)>>0)]=((HEAP8[((src)>>0)])|0);
        HEAP8[(((dest)+(1))>>0)]=((HEAP8[(((src)+(1))>>0)])|0);
        HEAP8[(((dest)+(2))>>0)]=((HEAP8[(((src)+(2))>>0)])|0);
        HEAP8[(((dest)+(3))>>0)]=((HEAP8[(((src)+(3))>>0)])|0);
        dest = (dest+4)|0;
        src = (src+4)|0;
      }
    }
    // The remaining unaligned < 4 byte tail.
    while ((dest|0) < (dest_end|0)) {
      HEAP8[((dest)>>0)]=((HEAP8[((src)>>0)])|0);
      dest = (dest+1)|0;
      src = (src+1)|0;
    }
    return ret|0;
}
function _memset(ptr, value, num) {
    ptr = ptr|0; value = value|0; num = num|0;
    var end = 0, aligned_end = 0, block_aligned_end = 0, value4 = 0;
    end = (ptr + num)|0;

    value = value & 0xff;
    if ((num|0) >= 67 /* 64 bytes for an unrolled loop + 3 bytes for unaligned head*/) {
      while ((ptr&3) != 0) {
        HEAP8[((ptr)>>0)]=value;
        ptr = (ptr+1)|0;
      }

      aligned_end = (end & -4)|0;
      value4 = value | (value << 8) | (value << 16) | (value << 24);

      block_aligned_end = (aligned_end - 64)|0;

      while((ptr|0) <= (block_aligned_end|0)) {
        HEAP32[((ptr)>>2)]=value4;
        HEAP32[(((ptr)+(4))>>2)]=value4;
        HEAP32[(((ptr)+(8))>>2)]=value4;
        HEAP32[(((ptr)+(12))>>2)]=value4;
        HEAP32[(((ptr)+(16))>>2)]=value4;
        HEAP32[(((ptr)+(20))>>2)]=value4;
        HEAP32[(((ptr)+(24))>>2)]=value4;
        HEAP32[(((ptr)+(28))>>2)]=value4;
        HEAP32[(((ptr)+(32))>>2)]=value4;
        HEAP32[(((ptr)+(36))>>2)]=value4;
        HEAP32[(((ptr)+(40))>>2)]=value4;
        HEAP32[(((ptr)+(44))>>2)]=value4;
        HEAP32[(((ptr)+(48))>>2)]=value4;
        HEAP32[(((ptr)+(52))>>2)]=value4;
        HEAP32[(((ptr)+(56))>>2)]=value4;
        HEAP32[(((ptr)+(60))>>2)]=value4;
        ptr = (ptr + 64)|0;
      }

      while ((ptr|0) < (aligned_end|0) ) {
        HEAP32[((ptr)>>2)]=value4;
        ptr = (ptr+4)|0;
      }
    }
    // The remaining bytes.
    while ((ptr|0) < (end|0)) {
      HEAP8[((ptr)>>0)]=value;
      ptr = (ptr+1)|0;
    }
    return (end-num)|0;
}
function _sbrk(increment) {
    increment = increment|0;
    var oldDynamicTop = 0;
    var oldDynamicTopOnChange = 0;
    var newDynamicTop = 0;
    var totalMemory = 0;
    totalMemory = _emscripten_get_heap_size()|0;

      oldDynamicTop = HEAP32[DYNAMICTOP_PTR>>2]|0;
      newDynamicTop = oldDynamicTop + increment | 0;

      if (((increment|0) > 0 & (newDynamicTop|0) < (oldDynamicTop|0)) // Detect and fail if we would wrap around signed 32-bit int.
        | (newDynamicTop|0) < 0) { // Also underflow, sbrk() should be able to be used to subtract.
        abortOnCannotGrowMemory(newDynamicTop|0)|0;
        ___setErrNo(12);
        return -1;
      }

      if ((newDynamicTop|0) > (totalMemory|0)) {
        if (_emscripten_resize_heap(newDynamicTop|0)|0) {
          // We resized the heap. Start another loop iteration if we need to.
        } else {
          // We failed to resize the heap.
          ___setErrNo(12);
          return -1;
        }
      }

      HEAP32[DYNAMICTOP_PTR>>2] = newDynamicTop|0;

    return oldDynamicTop|0;
}

  
function dynCall_ii(index,a1) {
  index = index|0;
  a1=a1|0;
  return FUNCTION_TABLE_ii[index&1](a1|0)|0;
}


function dynCall_iidiiii(index,a1,a2,a3,a4,a5,a6) {
  index = index|0;
  a1=a1|0; a2=+a2; a3=a3|0; a4=a4|0; a5=a5|0; a6=a6|0;
  return FUNCTION_TABLE_iidiiii[index&7](a1|0,+a2,a3|0,a4|0,a5|0,a6|0)|0;
}


function dynCall_iiii(index,a1,a2,a3) {
  index = index|0;
  a1=a1|0; a2=a2|0; a3=a3|0;
  return FUNCTION_TABLE_iiii[index&7](a1|0,a2|0,a3|0)|0;
}


function dynCall_iiiii(index,a1,a2,a3,a4) {
  index = index|0;
  a1=a1|0; a2=a2|0; a3=a3|0; a4=a4|0;
  return FUNCTION_TABLE_iiiii[index&3](a1|0,a2|0,a3|0,a4|0)|0;
}


function dynCall_vii(index,a1,a2) {
  index = index|0;
  a1=a1|0; a2=a2|0;
  FUNCTION_TABLE_vii[index&7](a1|0,a2|0);
}

function b0(p0) {
 p0 = p0|0; nullFunc_ii(0);return 0;
}
function b1(p0,p1,p2,p3,p4,p5) {
 p0 = p0|0;p1 = +p1;p2 = p2|0;p3 = p3|0;p4 = p4|0;p5 = p5|0; nullFunc_iidiiii(1);return 0;
}
function b2(p0,p1,p2) {
 p0 = p0|0;p1 = p1|0;p2 = p2|0; nullFunc_iiii(2);return 0;
}
function b3(p0,p1,p2,p3) {
 p0 = p0|0;p1 = p1|0;p2 = p2|0;p3 = p3|0; nullFunc_iiiii(3);return 0;
}
function b4(p0,p1) {
 p0 = p0|0;p1 = p1|0; nullFunc_vii(4);
}

// EMSCRIPTEN_END_FUNCS
var FUNCTION_TABLE_ii = [b0,___stdio_close];
var FUNCTION_TABLE_iidiiii = [b1,b1,b1,b1,b1,_fmt_fp,b1,b1];
var FUNCTION_TABLE_iiii = [b2,b2,___stdout_write,b2,___stdio_write,b2,b2,b2];
var FUNCTION_TABLE_iiiii = [b3,b3,b3,___stdio_seek];
var FUNCTION_TABLE_vii = [b4,b4,b4,b4,b4,b4,_pop_arg_long_double,b4];

  return { ___errno_location: ___errno_location, ___muldi3: ___muldi3, ___udivdi3: ___udivdi3, _bitshift64Lshr: _bitshift64Lshr, _bitshift64Shl: _bitshift64Shl, _fflush: _fflush, _free: _free, _i64Add: _i64Add, _i64Subtract: _i64Subtract, _main: _main, _malloc: _malloc, _memcpy: _memcpy, _memset: _memset, _sbrk: _sbrk, dynCall_ii: dynCall_ii, dynCall_iidiiii: dynCall_iidiiii, dynCall_iiii: dynCall_iiii, dynCall_iiiii: dynCall_iiiii, dynCall_vii: dynCall_vii, establishStackSpace: establishStackSpace, stackAlloc: stackAlloc, stackRestore: stackRestore, stackSave: stackSave };
})
// EMSCRIPTEN_END_ASM
(asmGlobalArg, asmLibraryArg, buffer);

var real____errno_location = asm["___errno_location"];
asm["___errno_location"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real____errno_location.apply(null, arguments);
};

var real____muldi3 = asm["___muldi3"];
asm["___muldi3"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real____muldi3.apply(null, arguments);
};

var real____udivdi3 = asm["___udivdi3"];
asm["___udivdi3"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real____udivdi3.apply(null, arguments);
};

var real__bitshift64Lshr = asm["_bitshift64Lshr"];
asm["_bitshift64Lshr"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__bitshift64Lshr.apply(null, arguments);
};

var real__bitshift64Shl = asm["_bitshift64Shl"];
asm["_bitshift64Shl"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__bitshift64Shl.apply(null, arguments);
};

var real__fflush = asm["_fflush"];
asm["_fflush"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__fflush.apply(null, arguments);
};

var real__free = asm["_free"];
asm["_free"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__free.apply(null, arguments);
};

var real__i64Add = asm["_i64Add"];
asm["_i64Add"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__i64Add.apply(null, arguments);
};

var real__i64Subtract = asm["_i64Subtract"];
asm["_i64Subtract"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__i64Subtract.apply(null, arguments);
};

var real__main = asm["_main"];
asm["_main"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__main.apply(null, arguments);
};

var real__malloc = asm["_malloc"];
asm["_malloc"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__malloc.apply(null, arguments);
};

var real__sbrk = asm["_sbrk"];
asm["_sbrk"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__sbrk.apply(null, arguments);
};

var real_establishStackSpace = asm["establishStackSpace"];
asm["establishStackSpace"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real_establishStackSpace.apply(null, arguments);
};

var real_stackAlloc = asm["stackAlloc"];
asm["stackAlloc"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real_stackAlloc.apply(null, arguments);
};

var real_stackRestore = asm["stackRestore"];
asm["stackRestore"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real_stackRestore.apply(null, arguments);
};

var real_stackSave = asm["stackSave"];
asm["stackSave"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real_stackSave.apply(null, arguments);
};
var ___errno_location = Module["___errno_location"] = asm["___errno_location"];
var ___muldi3 = Module["___muldi3"] = asm["___muldi3"];
var ___udivdi3 = Module["___udivdi3"] = asm["___udivdi3"];
var _bitshift64Lshr = Module["_bitshift64Lshr"] = asm["_bitshift64Lshr"];
var _bitshift64Shl = Module["_bitshift64Shl"] = asm["_bitshift64Shl"];
var _fflush = Module["_fflush"] = asm["_fflush"];
var _free = Module["_free"] = asm["_free"];
var _i64Add = Module["_i64Add"] = asm["_i64Add"];
var _i64Subtract = Module["_i64Subtract"] = asm["_i64Subtract"];
var _main = Module["_main"] = asm["_main"];
var _malloc = Module["_malloc"] = asm["_malloc"];
var _memcpy = Module["_memcpy"] = asm["_memcpy"];
var _memset = Module["_memset"] = asm["_memset"];
var _sbrk = Module["_sbrk"] = asm["_sbrk"];
var establishStackSpace = Module["establishStackSpace"] = asm["establishStackSpace"];
var stackAlloc = Module["stackAlloc"] = asm["stackAlloc"];
var stackRestore = Module["stackRestore"] = asm["stackRestore"];
var stackSave = Module["stackSave"] = asm["stackSave"];
var dynCall_ii = Module["dynCall_ii"] = asm["dynCall_ii"];
var dynCall_iidiiii = Module["dynCall_iidiiii"] = asm["dynCall_iidiiii"];
var dynCall_iiii = Module["dynCall_iiii"] = asm["dynCall_iiii"];
var dynCall_iiiii = Module["dynCall_iiiii"] = asm["dynCall_iiiii"];
var dynCall_vii = Module["dynCall_vii"] = asm["dynCall_vii"];
;



// === Auto-generated postamble setup entry stuff ===

Module['asm'] = asm;

if (!Module["intArrayFromString"]) Module["intArrayFromString"] = function() { abort("'intArrayFromString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["intArrayToString"]) Module["intArrayToString"] = function() { abort("'intArrayToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["ccall"]) Module["ccall"] = function() { abort("'ccall' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["cwrap"]) Module["cwrap"] = function() { abort("'cwrap' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["setValue"]) Module["setValue"] = function() { abort("'setValue' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["getValue"]) Module["getValue"] = function() { abort("'getValue' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["allocate"]) Module["allocate"] = function() { abort("'allocate' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["getMemory"]) Module["getMemory"] = function() { abort("'getMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Module["AsciiToString"]) Module["AsciiToString"] = function() { abort("'AsciiToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["stringToAscii"]) Module["stringToAscii"] = function() { abort("'stringToAscii' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["UTF8ArrayToString"]) Module["UTF8ArrayToString"] = function() { abort("'UTF8ArrayToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["UTF8ToString"]) Module["UTF8ToString"] = function() { abort("'UTF8ToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["stringToUTF8Array"]) Module["stringToUTF8Array"] = function() { abort("'stringToUTF8Array' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["stringToUTF8"]) Module["stringToUTF8"] = function() { abort("'stringToUTF8' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["lengthBytesUTF8"]) Module["lengthBytesUTF8"] = function() { abort("'lengthBytesUTF8' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["UTF16ToString"]) Module["UTF16ToString"] = function() { abort("'UTF16ToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["stringToUTF16"]) Module["stringToUTF16"] = function() { abort("'stringToUTF16' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["lengthBytesUTF16"]) Module["lengthBytesUTF16"] = function() { abort("'lengthBytesUTF16' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["UTF32ToString"]) Module["UTF32ToString"] = function() { abort("'UTF32ToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["stringToUTF32"]) Module["stringToUTF32"] = function() { abort("'stringToUTF32' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["lengthBytesUTF32"]) Module["lengthBytesUTF32"] = function() { abort("'lengthBytesUTF32' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["allocateUTF8"]) Module["allocateUTF8"] = function() { abort("'allocateUTF8' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["stackTrace"]) Module["stackTrace"] = function() { abort("'stackTrace' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["addOnPreRun"]) Module["addOnPreRun"] = function() { abort("'addOnPreRun' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["addOnInit"]) Module["addOnInit"] = function() { abort("'addOnInit' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["addOnPreMain"]) Module["addOnPreMain"] = function() { abort("'addOnPreMain' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["addOnExit"]) Module["addOnExit"] = function() { abort("'addOnExit' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["addOnPostRun"]) Module["addOnPostRun"] = function() { abort("'addOnPostRun' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["writeStringToMemory"]) Module["writeStringToMemory"] = function() { abort("'writeStringToMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["writeArrayToMemory"]) Module["writeArrayToMemory"] = function() { abort("'writeArrayToMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["writeAsciiToMemory"]) Module["writeAsciiToMemory"] = function() { abort("'writeAsciiToMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["addRunDependency"]) Module["addRunDependency"] = function() { abort("'addRunDependency' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Module["removeRunDependency"]) Module["removeRunDependency"] = function() { abort("'removeRunDependency' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Module["ENV"]) Module["ENV"] = function() { abort("'ENV' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["FS"]) Module["FS"] = function() { abort("'FS' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["FS_createFolder"]) Module["FS_createFolder"] = function() { abort("'FS_createFolder' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Module["FS_createPath"]) Module["FS_createPath"] = function() { abort("'FS_createPath' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Module["FS_createDataFile"]) Module["FS_createDataFile"] = function() { abort("'FS_createDataFile' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Module["FS_createPreloadedFile"]) Module["FS_createPreloadedFile"] = function() { abort("'FS_createPreloadedFile' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Module["FS_createLazyFile"]) Module["FS_createLazyFile"] = function() { abort("'FS_createLazyFile' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Module["FS_createLink"]) Module["FS_createLink"] = function() { abort("'FS_createLink' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Module["FS_createDevice"]) Module["FS_createDevice"] = function() { abort("'FS_createDevice' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Module["FS_unlink"]) Module["FS_unlink"] = function() { abort("'FS_unlink' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Module["GL"]) Module["GL"] = function() { abort("'GL' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["dynamicAlloc"]) Module["dynamicAlloc"] = function() { abort("'dynamicAlloc' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["warnOnce"]) Module["warnOnce"] = function() { abort("'warnOnce' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["loadDynamicLibrary"]) Module["loadDynamicLibrary"] = function() { abort("'loadDynamicLibrary' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["loadWebAssemblyModule"]) Module["loadWebAssemblyModule"] = function() { abort("'loadWebAssemblyModule' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["getLEB"]) Module["getLEB"] = function() { abort("'getLEB' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["getFunctionTables"]) Module["getFunctionTables"] = function() { abort("'getFunctionTables' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["alignFunctionTables"]) Module["alignFunctionTables"] = function() { abort("'alignFunctionTables' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["registerFunctions"]) Module["registerFunctions"] = function() { abort("'registerFunctions' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["addFunction"]) Module["addFunction"] = function() { abort("'addFunction' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["removeFunction"]) Module["removeFunction"] = function() { abort("'removeFunction' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["getFuncWrapper"]) Module["getFuncWrapper"] = function() { abort("'getFuncWrapper' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["prettyPrint"]) Module["prettyPrint"] = function() { abort("'prettyPrint' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["makeBigInt"]) Module["makeBigInt"] = function() { abort("'makeBigInt' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["dynCall"]) Module["dynCall"] = function() { abort("'dynCall' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["getCompilerSetting"]) Module["getCompilerSetting"] = function() { abort("'getCompilerSetting' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["stackSave"]) Module["stackSave"] = function() { abort("'stackSave' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["stackRestore"]) Module["stackRestore"] = function() { abort("'stackRestore' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["stackAlloc"]) Module["stackAlloc"] = function() { abort("'stackAlloc' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["establishStackSpace"]) Module["establishStackSpace"] = function() { abort("'establishStackSpace' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["print"]) Module["print"] = function() { abort("'print' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["printErr"]) Module["printErr"] = function() { abort("'printErr' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["getTempRet0"]) Module["getTempRet0"] = function() { abort("'getTempRet0' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["setTempRet0"]) Module["setTempRet0"] = function() { abort("'setTempRet0' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["Pointer_stringify"]) Module["Pointer_stringify"] = function() { abort("'Pointer_stringify' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["intArrayFromBase64"]) Module["intArrayFromBase64"] = function() { abort("'intArrayFromBase64' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Module["tryParseAsDataURI"]) Module["tryParseAsDataURI"] = function() { abort("'tryParseAsDataURI' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };if (!Module["ALLOC_NORMAL"]) Object.defineProperty(Module, "ALLOC_NORMAL", { get: function() { abort("'ALLOC_NORMAL' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } });
if (!Module["ALLOC_STACK"]) Object.defineProperty(Module, "ALLOC_STACK", { get: function() { abort("'ALLOC_STACK' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } });
if (!Module["ALLOC_DYNAMIC"]) Object.defineProperty(Module, "ALLOC_DYNAMIC", { get: function() { abort("'ALLOC_DYNAMIC' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } });
if (!Module["ALLOC_NONE"]) Object.defineProperty(Module, "ALLOC_NONE", { get: function() { abort("'ALLOC_NONE' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } });

if (memoryInitializer) {
  if (!isDataURI(memoryInitializer)) {
    memoryInitializer = locateFile(memoryInitializer);
  }
  if (ENVIRONMENT_IS_NODE || ENVIRONMENT_IS_SHELL) {
    var data = Module['readBinary'](memoryInitializer);
    HEAPU8.set(data, GLOBAL_BASE);
  } else {
    addRunDependency('memory initializer');
    var applyMemoryInitializer = function(data) {
      if (data.byteLength) data = new Uint8Array(data);
      for (var i = 0; i < data.length; i++) {
        assert(HEAPU8[GLOBAL_BASE + i] === 0, "area for memory initializer should not have been touched before it's loaded");
      }
      HEAPU8.set(data, GLOBAL_BASE);
      // Delete the typed array that contains the large blob of the memory initializer request response so that
      // we won't keep unnecessary memory lying around. However, keep the XHR object itself alive so that e.g.
      // its .status field can still be accessed later.
      if (Module['memoryInitializerRequest']) delete Module['memoryInitializerRequest'].response;
      removeRunDependency('memory initializer');
    }
    var doBrowserLoad = function() {
      Module['readAsync'](memoryInitializer, applyMemoryInitializer, function() {
        throw 'could not load memory initializer ' + memoryInitializer;
      });
    }
    var memoryInitializerBytes = tryParseAsDataURI(memoryInitializer);
    if (memoryInitializerBytes) {
      applyMemoryInitializer(memoryInitializerBytes.buffer);
    } else
    if (Module['memoryInitializerRequest']) {
      // a network request has already been created, just use that
      var useRequest = function() {
        var request = Module['memoryInitializerRequest'];
        var response = request.response;
        if (request.status !== 200 && request.status !== 0) {
          var data = tryParseAsDataURI(Module['memoryInitializerRequestURL']);
          if (data) {
            response = data.buffer;
          } else {
            // If you see this warning, the issue may be that you are using locateFile and defining it in JS. That
            // means that the HTML file doesn't know about it, and when it tries to create the mem init request early, does it to the wrong place.
            // Look in your browser's devtools network console to see what's going on.
            console.warn('a problem seems to have happened with Module.memoryInitializerRequest, status: ' + request.status + ', retrying ' + memoryInitializer);
            doBrowserLoad();
            return;
          }
        }
        applyMemoryInitializer(response);
      }
      if (Module['memoryInitializerRequest'].response) {
        setTimeout(useRequest, 0); // it's already here; but, apply it asynchronously
      } else {
        Module['memoryInitializerRequest'].addEventListener('load', useRequest); // wait for it
      }
    } else {
      // fetch it from the network ourselves
      doBrowserLoad();
    }
  }
}



/**
 * @constructor
 * @extends {Error}
 * @this {ExitStatus}
 */
function ExitStatus(status) {
  this.name = "ExitStatus";
  this.message = "Program terminated with exit(" + status + ")";
  this.status = status;
};
ExitStatus.prototype = new Error();
ExitStatus.prototype.constructor = ExitStatus;

var calledMain = false;

dependenciesFulfilled = function runCaller() {
  // If run has never been called, and we should call run (INVOKE_RUN is true, and Module.noInitialRun is not false)
  if (!Module['calledRun']) run();
  if (!Module['calledRun']) dependenciesFulfilled = runCaller; // try this again later, after new deps are fulfilled
}

Module['callMain'] = function callMain(args) {
  assert(runDependencies == 0, 'cannot call main when async dependencies remain! (listen on Module["onRuntimeInitialized"])');
  assert(__ATPRERUN__.length == 0, 'cannot call main when preRun functions remain to be called');

  args = args || [];

  var argc = args.length+1;
  var argv = stackAlloc((argc + 1) * 4);
  HEAP32[argv >> 2] = allocateUTF8OnStack(Module['thisProgram']);
  for (var i = 1; i < argc; i++) {
    HEAP32[(argv >> 2) + i] = allocateUTF8OnStack(args[i - 1]);
  }
  HEAP32[(argv >> 2) + argc] = 0;


  try {

    var ret = Module['_main'](argc, argv, 0);


    // if we're not running an evented main loop, it's time to exit
      exit(ret, /* implicit = */ true);
  }
  catch(e) {
    if (e instanceof ExitStatus) {
      // exit() throws this once it's done to make sure execution
      // has been stopped completely
      return;
    } else if (e == 'SimulateInfiniteLoop') {
      // running an evented main loop, don't immediately exit
      Module['noExitRuntime'] = true;
      return;
    } else {
      var toLog = e;
      if (e && typeof e === 'object' && e.stack) {
        toLog = [e, e.stack];
      }
      err('exception thrown: ' + toLog);
      Module['quit'](1, e);
    }
  } finally {
    calledMain = true;
  }
}




/** @type {function(Array=)} */
function run(args) {
  args = args || Module['arguments'];

  if (runDependencies > 0) {
    return;
  }

  writeStackCookie();

  preRun();

  if (runDependencies > 0) return; // a preRun added a dependency, run will be called later
  if (Module['calledRun']) return; // run may have just been called through dependencies being fulfilled just in this very frame

  function doRun() {
    if (Module['calledRun']) return; // run may have just been called while the async setStatus time below was happening
    Module['calledRun'] = true;

    if (ABORT) return;

    initRuntime();

    preMain();

    if (Module['onRuntimeInitialized']) Module['onRuntimeInitialized']();

    if (Module['_main'] && shouldRunNow) Module['callMain'](args);

    postRun();
  }

  if (Module['setStatus']) {
    Module['setStatus']('Running...');
    setTimeout(function() {
      setTimeout(function() {
        Module['setStatus']('');
      }, 1);
      doRun();
    }, 1);
  } else {
    doRun();
  }
  checkStackCookie();
}
Module['run'] = run;

function checkUnflushedContent() {
  // Compiler settings do not allow exiting the runtime, so flushing
  // the streams is not possible. but in ASSERTIONS mode we check
  // if there was something to flush, and if so tell the user they
  // should request that the runtime be exitable.
  // Normally we would not even include flush() at all, but in ASSERTIONS
  // builds we do so just for this check, and here we see if there is any
  // content to flush, that is, we check if there would have been
  // something a non-ASSERTIONS build would have not seen.
  // How we flush the streams depends on whether we are in SYSCALLS_REQUIRE_FILESYSTEM=0
  // mode (which has its own special function for this; otherwise, all
  // the code is inside libc)
  var print = out;
  var printErr = err;
  var has = false;
  out = err = function(x) {
    has = true;
  }
  try { // it doesn't matter if it fails
    var flush = flush_NO_FILESYSTEM;
    if (flush) flush(0);
  } catch(e) {}
  out = print;
  err = printErr;
  if (has) {
    warnOnce('stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the FAQ), or make sure to emit a newline when you printf etc.');
    warnOnce('(this may also be due to not including full filesystem support - try building with -s FORCE_FILESYSTEM=1)');
  }
}

function exit(status, implicit) {
  checkUnflushedContent();

  // if this is just main exit-ing implicitly, and the status is 0, then we
  // don't need to do anything here and can just leave. if the status is
  // non-zero, though, then we need to report it.
  // (we may have warned about this earlier, if a situation justifies doing so)
  if (implicit && Module['noExitRuntime'] && status === 0) {
    return;
  }

  if (Module['noExitRuntime']) {
    // if exit() was called, we may warn the user if the runtime isn't actually being shut down
    if (!implicit) {
      err('exit(' + status + ') called, but EXIT_RUNTIME is not set, so halting execution but not exiting the runtime or preventing further async execution (build with EXIT_RUNTIME=1, if you want a true shutdown)');
    }
  } else {

    ABORT = true;
    EXITSTATUS = status;

    exitRuntime();

    if (Module['onExit']) Module['onExit'](status);
  }

  Module['quit'](status, new ExitStatus(status));
}

var abortDecorators = [];

function abort(what) {
  if (Module['onAbort']) {
    Module['onAbort'](what);
  }

  if (what !== undefined) {
    out(what);
    err(what);
    what = '"' + what + '"';
  } else {
    what = '';
  }

  ABORT = true;
  EXITSTATUS = 1;

  var extra = '';
  var output = 'abort(' + what + ') at ' + stackTrace() + extra;
  if (abortDecorators) {
    abortDecorators.forEach(function(decorator) {
      output = decorator(output, what);
    });
  }
  throw output;
}
Module['abort'] = abort;

if (Module['preInit']) {
  if (typeof Module['preInit'] == 'function') Module['preInit'] = [Module['preInit']];
  while (Module['preInit'].length > 0) {
    Module['preInit'].pop()();
  }
}

// shouldRunNow refers to calling main(), not run().
var shouldRunNow = true;
if (Module['noInitialRun']) {
  shouldRunNow = false;
}

  Module["noExitRuntime"] = true;

run();





// {{MODULE_ADDITIONS}}



