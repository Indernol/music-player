//! Does rustypipe SEARCH work with the default UA vs the Oculus VR UA?
//! Confirms the VR UA (set globally on rustypipe) is what broke search.

use rustypipe::client::RustyPipe;

const VR_UA: &str = "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip";

fn main() {
    tauri::async_runtime::block_on(run());
}

async fn run() {
    for (label, ua) in [("default UA", None), ("VR UA", Some(VR_UA))] {
        let dir = std::env::temp_dir().join(format!("mp-search-{}", label.replace(' ', "_")));
        let _ = std::fs::create_dir_all(&dir);
        let mut b = RustyPipe::builder().storage_dir(dir);
        if let Some(u) = ua { b = b.user_agent(u); }
        let rp = b.build().unwrap();
        match rp.query().search::<rustypipe::model::VideoItem, _>("Ado").await {
            Ok(r) => println!("[{label}] search OK: {} results", r.items.items.len()),
            Err(e) => println!("[{label}] search ERR: {e}"),
        }
    }
}
