#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod core;
#[cfg(windows)]
mod desktop;
mod layouts;
#[cfg(windows)]
mod metrics;
mod playtime;
mod updates;
#[cfg(windows)]
mod web;

fn main() {
    #[cfg(windows)]
    if let Err(error) = desktop::run() {
        if cfg!(feature = "test-driver")
            && std::env::var("FOUNDRY_CLIENT_TEST").as_deref() == Ok("1")
        {
            eprintln!("{error}");
            std::process::exit(1);
        }
        rfd::MessageDialog::new()
            .set_title("Foundry Client could not start")
            .set_description(format!(
                "{error}\n\nMicrosoft Edge WebView2 Runtime is required."
            ))
            .set_level(rfd::MessageLevel::Error)
            .show();
    }
    #[cfg(not(windows))]
    eprintln!("This build targets Windows 10/11 with WebView2.");
}
