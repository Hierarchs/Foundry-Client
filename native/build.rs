fn main() {
    println!("cargo:rerun-if-changed=../src/ui");
    println!("cargo:rerun-if-changed=../src/foundry-adapter.js");
    println!("cargo:rerun-if-changed=../src/performance-adapter.js");
    let compiler = std::process::Command::new("rustc")
        .arg("--version")
        .output()
        .expect("rustc");
    println!(
        "cargo:rustc-env=FOUNDRY_RUST_VERSION={}",
        String::from_utf8_lossy(&compiler.stdout).trim()
    );
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        winresource::WindowsResource::new()
            .set_icon("../src/ui/icon.ico")
            .set("ProductName", "Foundry Client")
            .set("FileDescription", "Foundry Client — native Rust runtime")
            .set("LegalCopyright", "Hierarchs")
            .compile()
            .expect("Windows SDK resource compiler required");
    }
}
