//! Verify the ANDROID_VR resolve + fetch path in Rust/ureq (mirrors ytnative).
//! Usage: cargo run --example native_fetch -- <videoId>

const VR_UA: &str = "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip";

fn main() {
    let id = std::env::args().nth(1).unwrap_or_else(|| "Qp3b-RXtz4w".to_string());

    let html = ureq::get("https://www.youtube.com/")
        .set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0")
        .call().unwrap().into_string().unwrap();
    let vd = html.split_once("\"visitorData\":\"").and_then(|(_, r)| r.split_once('"')).map(|(v, _)| v.to_string()).expect("visitorData");
    println!("visitorData: {}…", &vd[..20]);

    let body = serde_json::json!({
        "context": { "client": {
            "clientName": "ANDROID_VR", "clientVersion": "1.62.27",
            "deviceMake": "Oculus", "deviceModel": "Quest 3", "androidSdkVersion": 32,
            "osName": "Android", "osVersion": "12L", "hl": "en", "gl": "US", "visitorData": vd,
        }},
        "videoId": id, "contentCheckOk": true, "racyCheckOk": true,
    });
    let v: serde_json::Value = ureq::post("https://www.youtube.com/youtubei/v1/player")
        .set("User-Agent", VR_UA)
        .set("X-YouTube-Client-Name", "28")
        .set("X-YouTube-Client-Version", "1.62.27")
        .send_json(body).unwrap().into_json().unwrap();
    println!("playability: {}", v["playabilityStatus"]["status"].as_str().unwrap_or("?"));
    println!("title: {}", v["videoDetails"]["title"].as_str().unwrap_or("?"));

    let fmts = v["streamingData"]["adaptiveFormats"].as_array().unwrap();
    let url = fmts.iter()
        .filter(|f| f["mimeType"].as_str().map(|m| m.contains("audio/mp4")).unwrap_or(false) && f["url"].as_str().is_some())
        .max_by_key(|f| f["bitrate"].as_u64().unwrap_or(0))
        .and_then(|f| f["url"].as_str()).unwrap().to_string();
    println!("picked audio url ok");

    match ureq::get(&url).set("User-Agent", VR_UA).set("Range", "bytes=0-100000").call() {
        Ok(r) => println!("FETCH OK: {} len={:?}", r.status(), r.header("Content-Length")),
        Err(ureq::Error::Status(c, _)) => println!("FETCH HTTP {c}"),
        Err(e) => println!("FETCH ERR {e}"),
    }
}
