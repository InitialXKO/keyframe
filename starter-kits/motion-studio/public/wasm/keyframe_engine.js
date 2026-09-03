let wasm;

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
/**
 * Build metadata for the compiled kernel.
 * @returns {string}
 */
export function kernel_build_info() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.kernel_build_info();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat64ArrayMemory0 = null;

function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let WASM_VECTOR_LEN = 0;

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder('utf-8') : { encode: () => { throw Error('TextEncoder not available') } } );

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_0.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedFloat32ArrayMemory0 = null;

function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
/**
 * @enum {0 | 1}
 */
export const BlendMode = Object.freeze({
    Override: 0, "0": "Override",
    Additive: 1, "1": "Additive",
});
/**
 * @enum {0 | 1 | 2 | 3 | 4 | 5 | 6}
 */
export const EasingType = Object.freeze({
    Linear: 0, "0": "Linear",
    Ease: 1, "1": "Ease",
    EaseIn: 2, "2": "EaseIn",
    EaseOut: 3, "3": "EaseOut",
    EaseInOut: 4, "4": "EaseInOut",
    CubicBezier: 5, "5": "CubicBezier",
    Step: 6, "6": "Step",
});

const KeyframeEngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_keyframeengine_free(ptr >>> 0, 1));

export class KeyframeEngine {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        KeyframeEngineFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_keyframeengine_free(ptr, 0);
    }
    /**
     * @param {number} start_ms
     * @param {number} end_ms
     * @param {number} fps
     * @returns {Uint8Array}
     */
    bake_chunk(start_ms, end_ms, fps) {
        const ret = wasm.keyframeengine_bake_chunk(this.__wbg_ptr, start_ms, end_ms, fps);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {number} start_ms
     * @param {number} end_ms
     * @param {number} fps
     * @returns {Uint8Array}
     */
    bake_range(start_ms, end_ms, fps) {
        const ret = wasm.keyframeengine_bake_range(this.__wbg_ptr, start_ms, end_ms, fps);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {number} value
     * @param {Float64Array} input_range
     * @param {Float64Array} output_range
     * @returns {number}
     */
    interpolate(value, input_range, output_range) {
        const ptr0 = passArrayF64ToWasm0(input_range, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(output_range, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.keyframeengine_interpolate(this.__wbg_ptr, value, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * Snapshot per-instance constants for the fast path. Call after all
     * clips/instances/timeline have been added (i.e. after `prepare()`).
     */
    prepare_fast() {
        wasm.keyframeengine_prepare_fast(this.__wbg_ptr);
    }
    /**
     * @param {string} clip_json
     */
    add_clip_json(clip_json) {
        const ptr0 = passStringToWasm0(clip_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.keyframeengine_add_clip_json(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {number}
     */
    instance_size() {
        const ret = wasm.keyframeengine_instance_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} frame
     * @param {number} fps
     * @param {number} damping
     * @param {number} stiffness
     * @returns {number}
     */
    spring_solver(frame, fps, damping, stiffness) {
        const ret = wasm.keyframeengine_spring_solver(this.__wbg_ptr, frame, fps, damping, stiffness);
        return ret;
    }
    /**
     * @param {number} global_time
     * @returns {number}
     */
    evaluate_frame(global_time) {
        const ret = wasm.keyframeengine_evaluate_frame(this.__wbg_ptr, global_time);
        return ret >>> 0;
    }
    /**
     * @returns {string}
     */
    export_ir_json() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.keyframeengine_export_ir_json(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} ir_json
     */
    import_ir_json(ir_json) {
        const ptr0 = passStringToWasm0(ir_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.keyframeengine_import_ir_json(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Pointer to the fast-path output buffer (count × 80 bytes,
     * `#[repr(C, align(16))]` — identical layout to `get_instance_buffer_ptr`).
     * @returns {number}
     */
    fast_buffer_ptr() {
        const ret = wasm.keyframeengine_fast_buffer_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} value
     * @param {Float64Array} input_range
     * @param {Float64Array} output_range
     * @param {string} opts_json
     * @returns {number}
     */
    interpolate_opts(value, input_range, output_range, opts_json) {
        const ptr0 = passArrayF64ToWasm0(input_range, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(output_range, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(opts_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.keyframeengine_interpolate_opts(this.__wbg_ptr, value, ptr0, len0, ptr1, len1, ptr2, len2);
        return ret;
    }
    /**
     * @param {string} instance_json
     */
    add_instance_json(instance_json) {
        const ptr0 = passStringToWasm0(instance_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.keyframeengine_add_instance_json(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Fast evaluate: zero heap allocations per frame.
     * Returns the number of evaluated instances.
     * @param {number} global_time
     * @returns {number}
     */
    evaluate_frame_fast(global_time) {
        const ret = wasm.keyframeengine_evaluate_frame_fast(this.__wbg_ptr, global_time);
        return ret >>> 0;
    }
    /**
     * @param {Float32Array} p0
     * @param {Float32Array} p1
     * @param {Float32Array} p2
     * @param {Float32Array} p3
     * @param {number} t
     * @returns {Float32Array}
     */
    interpolate_path_3d(p0, p1, p2, p3, t) {
        const ptr0 = passArrayF32ToWasm0(p0, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(p1, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF32ToWasm0(p2, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF32ToWasm0(p3, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.keyframeengine_interpolate_path_3d(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, t);
        var v5 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v5;
    }
    /**
     * @param {string} timeline_json
     */
    set_root_timeline_json(timeline_json) {
        const ptr0 = passStringToWasm0(timeline_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.keyframeengine_set_root_timeline_json(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Valid byte length of the fast-path output buffer.
     * @returns {number}
     */
    fast_buffer_byte_length() {
        const ret = wasm.keyframeengine_fast_buffer_byte_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get_instance_buffer_ptr() {
        const ret = wasm.keyframeengine_get_instance_buffer_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} value
     * @param {Float64Array} input_range
     * @param {Float64Array} output_range
     * @param {string} extrapolate_left
     * @param {string} extrapolate_right
     * @returns {number}
     */
    interpolate_extrapolate(value, input_range, output_range, extrapolate_left, extrapolate_right) {
        const ptr0 = passArrayF64ToWasm0(input_range, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(output_range, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(extrapolate_left, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(extrapolate_right, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.keyframeengine_interpolate_extrapolate(this.__wbg_ptr, value, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        return ret;
    }
    /**
     * @returns {number}
     */
    get_instance_buffer_byte_length() {
        const ret = wasm.keyframeengine_get_instance_buffer_byte_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    constructor() {
        const ret = wasm.keyframeengine_new();
        this.__wbg_ptr = ret >>> 0;
        KeyframeEngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    prepare() {
        const ret = wasm.keyframeengine_prepare(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_0;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };
    imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_throw = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };

    return imports;
}

function __wbg_init_memory(imports, memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('keyframe_engine_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
