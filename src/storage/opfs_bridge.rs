use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(not(target_arch = "wasm32"))]
static NATIVE_OPFS_MOCK: Mutex<Option<HashMap<String, Vec<u8>>>> = Mutex::new(None);

#[cfg(not(target_arch = "wasm32"))]
fn with_mock_store<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, Vec<u8>>) -> R,
{
    let mut guard = NATIVE_OPFS_MOCK.lock().unwrap();
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    f(guard.as_mut().unwrap())
}

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(catch, js_namespace = ["window", "__KEYFRAME_OPFS_BRIDGE__"])]
    fn write_sync(key: &str, data: &[u8]) -> Result<(), JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["window", "__KEYFRAME_OPFS_BRIDGE__"])]
    fn read_sync(key: &str) -> Result<Vec<u8>, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["window", "__KEYFRAME_OPFS_BRIDGE__"])]
    fn remove_sync(key: &str) -> Result<(), JsValue>;

    #[wasm_bindgen(js_namespace = ["window", "__KEYFRAME_OPFS_BRIDGE__"])]
    fn exists(key: &str) -> bool;
}

pub fn opfs_write_sync(key: &str, data: &[u8]) -> Result<(), String> {
    #[cfg(target_arch = "wasm32")]
    {
        write_sync(key, data).map_err(|e| format!("{:?}", e))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        with_mock_store(|store| {
            store.insert(key.to_string(), data.to_vec());
        });
        Ok(())
    }
}

pub fn opfs_read_sync(key: &str) -> Result<Vec<u8>, String> {
    #[cfg(target_arch = "wasm32")]
    {
        read_sync(key).map_err(|e| format!("{:?}", e))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        with_mock_store(|store| {
            store
                .get(key)
                .cloned()
                .ok_or_else(|| format!("Key {} not found in OPFS", key))
        })
    }
}

pub fn opfs_remove_sync(key: &str) -> Result<(), String> {
    #[cfg(target_arch = "wasm32")]
    {
        remove_sync(key).map_err(|e| format!("{:?}", e))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        with_mock_store(|store| {
            store.remove(key);
        });
        Ok(())
    }
}

pub fn opfs_exists(key: &str) -> bool {
    #[cfg(target_arch = "wasm32")]
    {
        exists(key)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        with_mock_store(|store| store.contains_key(key))
    }
}
