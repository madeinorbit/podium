use minisign_verify::{PublicKey, Signature};
use std::{env, fs, process};

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let public_key = args.next().ok_or("usage: verifier <public-key-text> <artifact> <signature>")?;
    let artifact = args.next().ok_or("usage: verifier <public-key-text> <artifact> <signature>")?;
    let signature = args.next().ok_or("usage: verifier <public-key-text> <artifact> <signature>")?;
    if args.next().is_some() {
        return Err("usage: verifier <public-key-text> <artifact> <signature>".into());
    }

    let public_key = PublicKey::decode(&public_key).map_err(|error| error.to_string())?;
    let signature = Signature::from_file(&signature).map_err(|error| error.to_string())?;
    let bytes = fs::read(&artifact).map_err(|error| error.to_string())?;
    public_key
        .verify(&bytes, &signature, false)
        .map_err(|error| error.to_string())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("desktop candidate signature verification failed: {error}");
        process::exit(1);
    }
}
