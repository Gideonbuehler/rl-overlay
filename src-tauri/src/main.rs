// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--ocr-test") {
        if let Err(e) = rl_overlay_lib::ocr_test(&args[1..]) {
            eprintln!("ocr test failed: {e}");
        }
        return;
    }
    // Elevated relaunch from the first-run setup, to edit an install under Program Files.
    if args.first().map(String::as_str) == Some("--enable-stats-api") {
        std::process::exit(rl_overlay_lib::enable_from_args(&args[1..]));
    }
    if args.first().map(String::as_str) == Some("--mechanics-test") {
        rl_overlay_lib::mechanics_test(args.get(1).map_or("", String::as_str));
        return;
    }
    if args.first().map(String::as_str) == Some("--replay-test") {
        rl_overlay_lib::replay_test(args.get(1).map_or("", String::as_str));
        return;
    }
    rl_overlay_lib::run()
}
