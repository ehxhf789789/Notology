//! MP4 faststart re-muxer — moves the `moov` atom in front of `mdat` and
//! updates the sample-table chunk offsets so HTML5 `<video>` players (incl.
//! WebView2) can seek without first downloading the entire file.
//!
//! HanBin 2026-05-14: Rust port of the prototype in
//! `scripts/mp4-faststart.mjs`, after empirical confirmation on a 1.47 GB
//! Webex screen-recording (moov at 99.8% → moov at 0.0%, file size
//! preserved, no re-encoding, mdat byte-for-byte unchanged).
//!
//! Use:
//! ```ignore
//! use crate::core::mp4_faststart::{apply_faststart, is_faststart};
//! if !is_faststart(input)? {
//!     apply_faststart(input, output)?;
//! }
//! ```
//!
//! Algorithm (qt-faststart):
//!   1. Parse top-level atoms. Bail if no `moov` and no `mdat` (not MP4).
//!   2. If moov already precedes mdat → already faststart.
//!   3. Read full `moov` into memory (typically 1–10 MB even for huge
//!      videos — it's only the sample tables, not the media).
//!   4. Recursively walk container atoms inside moov, find every
//!      `stco` (32-bit chunk offsets) / `co64` (64-bit chunk offsets).
//!      Add `moov.size` to every entry — those are absolute file offsets
//!      that will shift forward by exactly that amount when mdat moves.
//!   5. Stream output: [pre-mdat bytes] → [modified moov] → [mdat] →
//!      [post-old-moov tail] (usually empty).

use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

const CHUNK_BUFFER: usize = 4 * 1024 * 1024; // 4 MB

/// Top-level atom types that contain child atoms — we descend into these
/// when hunting for stco/co64. Leaf atoms inside moov (mvhd / tkhd / stsd
/// / stts / etc.) are skipped because their internal bytes are not boxes.
const CONTAINER_TYPES: &[[u8; 4]] = &[
    *b"moov", *b"trak", *b"edts", *b"mdia", *b"minf", *b"dinf", *b"stbl",
    *b"udta", *b"mvex", *b"mfra", *b"moof", *b"traf", *b"meco",
];

#[derive(Debug, Clone, Copy)]
struct AtomInfo {
    offset: u64,
    size: u64,
    type_bytes: [u8; 4],
}

fn parse_top_level(path: &Path) -> Result<Vec<AtomInfo>, String> {
    let mut file = File::open(path).map_err(|e| format!("open: {e}"))?;
    let file_size = file.metadata().map_err(|e| format!("metadata: {e}"))?.len();
    let mut atoms = Vec::new();
    let mut offset = 0u64;
    let mut buf = [0u8; 16];

    while offset < file_size {
        file.seek(SeekFrom::Start(offset)).map_err(|e| format!("seek: {e}"))?;
        let n = file.read(&mut buf).map_err(|e| format!("read header: {e}"))?;
        if n < 8 {
            break;
        }
        let raw_size = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as u64;
        let type_bytes = [buf[4], buf[5], buf[6], buf[7]];

        let (size, header_size) = if raw_size == 1 {
            if n < 16 {
                break;
            }
            let extended = u64::from_be_bytes([
                buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15],
            ]);
            (extended, 16u64)
        } else if raw_size == 0 {
            // "Extends to end of file" semantic.
            (file_size - offset, 8u64)
        } else {
            (raw_size, 8u64)
        };

        if size < header_size || offset + size > file_size {
            // Truncated / malformed — stop here.
            break;
        }

        atoms.push(AtomInfo { offset, size, type_bytes });
        offset += size;
    }
    Ok(atoms)
}

/// Returns true if the input MP4 already has `moov` before `mdat`, or if
/// the file doesn't have the structure we recognize (in which case we
/// don't try to re-mux it).
pub fn is_faststart(path: &Path) -> Result<bool, String> {
    let atoms = parse_top_level(path)?;
    let moov_idx = atoms.iter().position(|a| &a.type_bytes == b"moov");
    let mdat_idx = atoms.iter().position(|a| &a.type_bytes == b"mdat");
    match (moov_idx, mdat_idx) {
        (Some(m), Some(d)) => Ok(m < d),
        // No moov OR no mdat → not a standard MP4, leave untouched.
        _ => Ok(true),
    }
}

/// Recursively scan a moov-atom buffer for `stco` and `co64` atoms and
/// return their byte-offsets within the buffer.
fn find_chunk_offset_atoms(buf: &[u8], base: usize, end: usize, found: &mut Vec<(usize, [u8; 4])>) {
    let mut off = base;
    while off + 8 <= end {
        let size = u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]) as usize;
        let type_bytes = [buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]];
        if size < 8 || off + size > end {
            break;
        }
        if &type_bytes == b"stco" || &type_bytes == b"co64" {
            found.push((off, type_bytes));
        } else if CONTAINER_TYPES.iter().any(|t| t == &type_bytes) {
            find_chunk_offset_atoms(buf, off + 8, off + size, found);
        }
        off += size;
    }
}

/// Add `shift` to every chunk-offset entry inside an stco/co64 atom.
/// Atom byte layout: size(4) + type(4) + version+flags(4) + count(4) + entries.
fn shift_chunk_offsets(
    moov_buf: &mut [u8],
    atom_off: usize,
    type_bytes: &[u8; 4],
    shift: u64,
) -> Result<(), String> {
    let count_off = atom_off + 8 + 4; // after size + type + version/flags
    let entry_count = u32::from_be_bytes([
        moov_buf[count_off],
        moov_buf[count_off + 1],
        moov_buf[count_off + 2],
        moov_buf[count_off + 3],
    ]) as usize;
    let data_start = count_off + 4;

    if type_bytes == b"stco" {
        for i in 0..entry_count {
            let p = data_start + i * 4;
            let v = u32::from_be_bytes([
                moov_buf[p], moov_buf[p + 1], moov_buf[p + 2], moov_buf[p + 3],
            ]) as u64;
            let nv = v + shift;
            if nv > u32::MAX as u64 {
                return Err(format!(
                    "stco entry {i} would overflow 32-bit after +{shift} shift \
                     (file needs co64 promotion — caller should fall back to original)"
                ));
            }
            let bytes = (nv as u32).to_be_bytes();
            moov_buf[p..p + 4].copy_from_slice(&bytes);
        }
    } else {
        // co64 — 64-bit offsets
        for i in 0..entry_count {
            let p = data_start + i * 8;
            let v = u64::from_be_bytes([
                moov_buf[p], moov_buf[p + 1], moov_buf[p + 2], moov_buf[p + 3],
                moov_buf[p + 4], moov_buf[p + 5], moov_buf[p + 6], moov_buf[p + 7],
            ]);
            let nv = v + shift;
            let bytes = nv.to_be_bytes();
            moov_buf[p..p + 8].copy_from_slice(&bytes);
        }
    }
    Ok(())
}

/// Re-mux `input` with moov in front of mdat, written to `output`.
/// If the input is already faststart, the output is a byte-identical copy.
pub fn apply_faststart(input: &Path, output: &Path) -> Result<(), String> {
    let atoms = parse_top_level(input)?;
    let moov = atoms
        .iter()
        .find(|a| &a.type_bytes == b"moov")
        .ok_or_else(|| "no moov atom in MP4".to_string())?;
    let mdat = atoms
        .iter()
        .find(|a| &a.type_bytes == b"mdat")
        .ok_or_else(|| "no mdat atom in MP4".to_string())?;

    if moov.offset < mdat.offset {
        // Already faststart — straight copy.
        std::fs::copy(input, output).map_err(|e| format!("copy: {e}"))?;
        return Ok(());
    }

    // Read full moov into memory.
    let moov_size = usize::try_from(moov.size)
        .map_err(|_| format!("moov size {} exceeds usize", moov.size))?;
    let mut moov_buf = vec![0u8; moov_size];
    {
        let mut f = File::open(input).map_err(|e| format!("open moov-read: {e}"))?;
        f.seek(SeekFrom::Start(moov.offset)).map_err(|e| format!("seek moov: {e}"))?;
        f.read_exact(&mut moov_buf).map_err(|e| format!("read moov: {e}"))?;
    }

    // Shift all chunk offsets by moov.size (= how far mdat is about to move).
    let mut chunk_atoms = Vec::new();
    find_chunk_offset_atoms(&moov_buf, 8, moov_size, &mut chunk_atoms);
    for (off, type_bytes) in &chunk_atoms {
        shift_chunk_offsets(&mut moov_buf, *off, type_bytes, moov.size)?;
    }

    // Write output: pre-mdat → moov → mdat → tail.
    let file_size = std::fs::metadata(input)
        .map_err(|e| format!("metadata: {e}"))?
        .len();
    let pre_mdat_end = mdat.offset;
    let mdat_end = mdat.offset + mdat.size;
    let tail_start = moov.offset + moov.size;
    let tail_end = file_size;

    let out_file = File::create(output).map_err(|e| format!("create output: {e}"))?;
    let mut writer = BufWriter::with_capacity(CHUNK_BUFFER, out_file);
    let mut reader = File::open(input).map_err(|e| format!("open input-stream: {e}"))?;

    copy_range(&mut reader, &mut writer, 0, pre_mdat_end)?;
    writer.write_all(&moov_buf).map_err(|e| format!("write moov: {e}"))?;
    copy_range(&mut reader, &mut writer, mdat.offset, mdat_end)?;
    if tail_end > tail_start {
        copy_range(&mut reader, &mut writer, tail_start, tail_end)?;
    }

    writer.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

fn copy_range(
    reader: &mut File,
    writer: &mut BufWriter<File>,
    start: u64,
    end: u64,
) -> Result<(), String> {
    if end <= start {
        return Ok(());
    }
    reader.seek(SeekFrom::Start(start)).map_err(|e| format!("seek: {e}"))?;
    let mut buf = vec![0u8; CHUNK_BUFFER];
    let mut remaining = end - start;
    while remaining > 0 {
        let to_read = remaining.min(buf.len() as u64) as usize;
        reader.read_exact(&mut buf[..to_read]).map_err(|e| format!("read body: {e}"))?;
        writer.write_all(&buf[..to_read]).map_err(|e| format!("write body: {e}"))?;
        remaining -= to_read as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a synthetic non-faststart MP4: ftyp + mdat + moov-with-1-stco.
    /// Returns (file_path, expected_shift).
    fn make_synthetic_mp4(dir: &std::path::Path) -> (std::path::PathBuf, u64) {
        let path = dir.join("synth.mp4");
        let mut f = File::create(&path).unwrap();

        // ftyp: size(4) + "ftyp"(4) + major(4) + minor(4) + brand1(4) + brand2(4) = 24
        let ftyp_size: u32 = 24;
        f.write_all(&ftyp_size.to_be_bytes()).unwrap();
        f.write_all(b"ftyp").unwrap();
        f.write_all(b"isom").unwrap();
        f.write_all(&0u32.to_be_bytes()).unwrap();
        f.write_all(b"mp42").unwrap();
        f.write_all(b"avc1").unwrap(); // brand 2 fills the declared 24-byte size

        // mdat: header (8) + 16 bytes payload = 24 total
        let mdat_size: u32 = 24;
        f.write_all(&mdat_size.to_be_bytes()).unwrap();
        f.write_all(b"mdat").unwrap();
        f.write_all(&[0xAAu8; 16]).unwrap();

        // moov containing a single trak > mdia > minf > stbl > stco
        // stco: size(4) + type(4) + ver+flags(4) + count(4) + 1 entry(4) = 20
        // stbl: 8 + 20 = 28
        // minf: 8 + 28 = 36
        // mdia: 8 + 36 = 44
        // trak: 8 + 44 = 52
        // moov: 8 + 52 = 60
        let stco_entry: u32 = 56; // points into mdat (after ftyp + mdat header) — arbitrary for test
        let moov_total: u32 = 60;
        f.write_all(&moov_total.to_be_bytes()).unwrap();
        f.write_all(b"moov").unwrap();

        let trak_size: u32 = 52;
        f.write_all(&trak_size.to_be_bytes()).unwrap();
        f.write_all(b"trak").unwrap();

        let mdia_size: u32 = 44;
        f.write_all(&mdia_size.to_be_bytes()).unwrap();
        f.write_all(b"mdia").unwrap();

        let minf_size: u32 = 36;
        f.write_all(&minf_size.to_be_bytes()).unwrap();
        f.write_all(b"minf").unwrap();

        let stbl_size: u32 = 28;
        f.write_all(&stbl_size.to_be_bytes()).unwrap();
        f.write_all(b"stbl").unwrap();

        let stco_size: u32 = 20;
        f.write_all(&stco_size.to_be_bytes()).unwrap();
        f.write_all(b"stco").unwrap();
        f.write_all(&0u32.to_be_bytes()).unwrap(); // version+flags
        f.write_all(&1u32.to_be_bytes()).unwrap(); // entry_count
        f.write_all(&stco_entry.to_be_bytes()).unwrap(); // entry value

        f.sync_all().unwrap();
        (path, moov_total as u64)
    }

    #[test]
    fn detects_non_faststart() {
        let tmp = std::env::temp_dir().join("notology_faststart_test_detect");
        let _ = std::fs::create_dir_all(&tmp);
        let (path, _) = make_synthetic_mp4(&tmp);
        assert!(!is_faststart(&path).unwrap());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn apply_produces_faststart_output_with_shifted_stco() {
        let tmp = std::env::temp_dir().join("notology_faststart_test_apply");
        let _ = std::fs::create_dir_all(&tmp);
        let (in_path, moov_size) = make_synthetic_mp4(&tmp);
        let out_path = tmp.join("synth_fast.mp4");
        apply_faststart(&in_path, &out_path).unwrap();

        assert!(is_faststart(&out_path).unwrap(), "output must be faststart");

        // Read the stco entry from the output and confirm it shifted by +moov_size.
        // Output layout: ftyp(24) + moov(60) + mdat(24) — stco entry sits inside
        // moov; we walk in to find it.
        let bytes = std::fs::read(&out_path).unwrap();
        // ftyp(24) + 6 atom headers (48) + stco ver_flags(4) + count(4) = 80.
        let entry_off = 24 + 8 + 8 + 8 + 8 + 8 + 8 + 4 + 4;
        let entry = u32::from_be_bytes([
            bytes[entry_off],
            bytes[entry_off + 1],
            bytes[entry_off + 2],
            bytes[entry_off + 3],
        ]) as u64;
        assert_eq!(entry, 56 + moov_size, "stco entry must shift by +moov.size");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn already_faststart_is_byte_identical_copy() {
        // After re-muxing once, re-muxing again should be a no-op straight copy.
        let tmp = std::env::temp_dir().join("notology_faststart_test_idempotent");
        let _ = std::fs::create_dir_all(&tmp);
        let (in_path, _) = make_synthetic_mp4(&tmp);
        let fast1 = tmp.join("once.mp4");
        let fast2 = tmp.join("twice.mp4");
        apply_faststart(&in_path, &fast1).unwrap();
        apply_faststart(&fast1, &fast2).unwrap();
        let a = std::fs::read(&fast1).unwrap();
        let b = std::fs::read(&fast2).unwrap();
        assert_eq!(a, b, "re-mux of an already-faststart file must be identical");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Stage 4.5.1 audit invariant: re-muxing the same input three times in
    /// the same process must yield three byte-identical outputs. Defends
    /// against accidental nondeterminism (uninitialized buffer padding,
    /// HashMap iteration ordering, allocator-derived state) being introduced
    /// later. Production audit ran 21 fixtures × 3 runs across mp4/mov/m4v,
    /// stco/co64, single/mixed-track, free/uuid pre-mdat — see
    /// docs/architecture/stage_4_5_reports/4_5_1.md.
    #[test]
    fn three_run_byte_identity() {
        let tmp = std::env::temp_dir().join("notology_faststart_test_determinism");
        let _ = std::fs::create_dir_all(&tmp);
        let (in_path, _) = make_synthetic_mp4(&tmp);
        let mut hashes = Vec::with_capacity(3);
        for run in 0..3 {
            let out = tmp.join(format!("run{run}.mp4"));
            apply_faststart(&in_path, &out).unwrap();
            hashes.push(std::fs::read(&out).unwrap());
        }
        assert_eq!(hashes[0], hashes[1], "run0 vs run1 must be byte-identical");
        assert_eq!(hashes[1], hashes[2], "run1 vs run2 must be byte-identical");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
