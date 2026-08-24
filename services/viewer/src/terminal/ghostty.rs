//! Safe, renderer-oriented adapter over the vendored libghostty-vt C API.

use super::ffi;
use super::{
    CellAttributes, CursorState, DirtyRegion, GridSize, MouseEncoding, MouseTracking, TerminalCell,
    TerminalColor, TerminalCore, TerminalModes, TerminalUpdate,
};
use crate::graphics::{KittyAction, KittyGraphicsEvent};
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::fmt;
use std::mem;
use std::ptr;
use std::slice;
use std::sync::{Once, OnceLock};

static INSTALL_PNG_DECODER: Once = Once::new();
const KITTY_STORAGE_LIMIT: u64 = 64 * 1024 * 1024;
/// Cell pixel size used before the host's real metrics are known. libghostty
/// sizes a *classic* (non-virtual) placement that omits `c=`/`r=` by dividing
/// the image's pixel footprint by the cell size, so this must be non-zero or
/// every such placement collapses to a 0x0 grid. The 1:2 ratio matches
/// `graphics::CellAspect::default`.
const DEFAULT_CELL_PIXELS: (u32, u32) = (10, 20);
const APC_LIMIT: usize = 16 * 1024 * 1024;
const KITTY_UNICODE_PLACEHOLDER: char = '\u{10eeee}';
static KITTY_DIACRITICS: OnceLock<HashMap<char, u32>> = OnceLock::new();

#[derive(Clone, Copy)]
struct VirtualPlacement {
    image_id: u32,
    placement_id: u32,
    columns: u32,
    rows: u32,
    z: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct VirtualCell {
    column: u16,
    row: u16,
    image_column: u32,
    image_row: u32,
}

#[derive(Clone, Copy)]
struct VirtualCellGroup {
    column: u16,
    row: u16,
    image_column: u32,
    image_row: u32,
    columns: u16,
    rows: u16,
}

unsafe extern "C" fn decode_png(
    _userdata: *mut c_void,
    allocator: *const c_void,
    data: *const u8,
    data_len: usize,
    out: *mut ffi::SysImage,
) -> bool {
    if data.is_null() || out.is_null() {
        return false;
    }
    let bytes = unsafe { slice::from_raw_parts(data, data_len) };
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let Ok(mut reader) = decoder.read_info() else {
        return false;
    };
    let mut buffer = vec![0; reader.output_buffer_size()];
    let Ok(info) = reader.next_frame(&mut buffer) else {
        return false;
    };
    let frame = &buffer[..info.buffer_size()];
    let mut rgba = Vec::with_capacity(info.width as usize * info.height as usize * 4);
    match info.color_type {
        png::ColorType::Rgba => rgba.extend_from_slice(frame),
        png::ColorType::Rgb => {
            for p in frame.chunks_exact(3) {
                rgba.extend_from_slice(&[p[0], p[1], p[2], 255]);
            }
        }
        png::ColorType::Grayscale => {
            for p in frame {
                rgba.extend_from_slice(&[*p, *p, *p, 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for p in frame.chunks_exact(2) {
                rgba.extend_from_slice(&[p[0], p[0], p[0], p[1]]);
            }
        }
        png::ColorType::Indexed => return false,
    }
    let ptr = unsafe { ffi::ghostty_alloc(allocator, rgba.len()) };
    if ptr.is_null() {
        return false;
    }
    unsafe {
        ptr::copy_nonoverlapping(rgba.as_ptr(), ptr, rgba.len());
        out.write(ffi::SysImage {
            width: info.width,
            height: info.height,
            data: ptr,
            data_len: rgba.len(),
        });
    }
    true
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GhosttyError(ffi::ResultCode);

impl fmt::Display for GhosttyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "libghostty-vt error {}", self.0)
    }
}

impl std::error::Error for GhosttyError {}

fn checked(result: ffi::ResultCode) -> Result<(), GhosttyError> {
    if result == ffi::SUCCESS {
        Ok(())
    } else {
        Err(GhosttyError(result))
    }
}

#[derive(Default)]
struct CallbackState {
    replies: Vec<Vec<u8>>,
}

unsafe extern "C" fn write_pty(
    _terminal: ffi::Terminal,
    userdata: *mut c_void,
    bytes: *const u8,
    len: usize,
) {
    if userdata.is_null() || (bytes.is_null() && len != 0) {
        return;
    }
    let reply = if len == 0 {
        Vec::new()
    } else {
        // SAFETY: libghostty-vt guarantees callback bytes are live for this call.
        unsafe { slice::from_raw_parts(bytes, len) }.to_vec()
    };
    // SAFETY: userdata points to this terminal's boxed CallbackState.
    unsafe { &mut *userdata.cast::<CallbackState>() }
        .replies
        .push(reply);
}

unsafe extern "C" fn device_attributes(
    _terminal: ffi::Terminal,
    _userdata: *mut c_void,
    output: *mut ffi::DeviceAttributes,
) -> bool {
    if output.is_null() {
        return false;
    }
    // Advertise a conservative VT220-compatible color terminal.
    let mut features = [0; 64];
    features[..2].copy_from_slice(&[6, 22]);
    // SAFETY: output is a live out-parameter supplied by libghostty-vt.
    unsafe {
        output.write(ffi::DeviceAttributes {
            primary: ffi::DeviceAttributesPrimary {
                conformance_level: 62,
                features,
                num_features: 2,
            },
            secondary: ffi::DeviceAttributesSecondary {
                device_type: 1,
                firmware_version: 0,
                rom_cartridge: 0,
            },
            tertiary: ffi::DeviceAttributesTertiary { unit_id: 0 },
        });
    }
    true
}

/// Streaming terminal core backed by the pinned libghostty-vt C ABI.
pub struct GhosttyTerminal {
    raw: ffi::Terminal,
    size: GridSize,
    /// Host cell pixel size (width, height). Kitty's `gridSize` divides an
    /// image's pixel footprint by the cell size to size a *classic* (non-
    /// virtual) placement that omitted explicit `c=`/`r=`. Without a non-zero
    /// cell size libghostty returns a 0x0 grid and the placement is dropped.
    cell_pixels: (u32, u32),
    callbacks: Box<CallbackState>,
}

impl GhosttyTerminal {
    pub fn new(size: GridSize) -> Result<Self, GhosttyError> {
        Self::new_with_kitty_apc_limit(size, APC_LIMIT)
    }

    /// Constructs a terminal with an explicit per-command Kitty payload limit.
    /// The viewer uses a generous child-side limit; host-oracle tests use the
    /// protocol's 4096-byte limit to match strict terminal configurations.
    pub fn new_with_kitty_apc_limit(
        size: GridSize,
        kitty_apc_limit: usize,
    ) -> Result<Self, GhosttyError> {
        if size.columns == 0 || size.rows == 0 {
            return Err(GhosttyError(-2));
        }
        let mut raw = ptr::null_mut();
        // SAFETY: pointers and value options match the pinned C header.
        checked(unsafe {
            ffi::ghostty_terminal_new(
                ptr::null(),
                &mut raw,
                ffi::TerminalOptions {
                    cols: size.columns,
                    rows: size.rows,
                    max_scrollback: 10_000,
                },
            )
        })?;

        let mut terminal = Self {
            raw,
            size,
            cell_pixels: DEFAULT_CELL_PIXELS,
            callbacks: Box::default(),
        };
        INSTALL_PNG_DECODER.call_once(|| unsafe {
            let _ = ffi::ghostty_sys_set(1, (decode_png as *const ()).cast());
        });
        let userdata = (&mut *terminal.callbacks as *mut CallbackState).cast();
        // SAFETY: callback state is boxed (stable address) and outlives the C terminal.
        let setup = unsafe {
            checked(ffi::ghostty_terminal_set(raw, ffi::OPT_USERDATA, userdata))
                .and_then(|()| {
                    checked(ffi::ghostty_terminal_set(
                        raw,
                        ffi::OPT_WRITE_PTY,
                        (write_pty as *const ()).cast(),
                    ))
                })
                .and_then(|()| {
                    checked(ffi::ghostty_terminal_set(
                        raw,
                        ffi::OPT_DEVICE_ATTRIBUTES,
                        (device_attributes as *const ()).cast(),
                    ))
                })
                .and_then(|()| {
                    checked(ffi::ghostty_terminal_set(
                        raw,
                        ffi::OPT_KITTY_IMAGE_STORAGE_LIMIT,
                        (&KITTY_STORAGE_LIMIT as *const u64).cast(),
                    ))
                })
                .and_then(|()| {
                    checked(ffi::ghostty_terminal_set(
                        raw,
                        ffi::OPT_APC_MAX_BYTES,
                        (&APC_LIMIT as *const usize).cast(),
                    ))
                })
                .and_then(|()| {
                    checked(ffi::ghostty_terminal_set(
                        raw,
                        ffi::OPT_APC_MAX_BYTES_KITTY,
                        (&kitty_apc_limit as *const usize).cast(),
                    ))
                })
        };
        if let Err(error) = setup {
            // SAFETY: raw was successfully allocated above.
            unsafe { ffi::ghostty_terminal_free(raw) };
            return Err(error);
        }
        // Prime the host cell pixel metrics. `ghostty_terminal_new` leaves
        // `width_px`/`height_px` at zero; a classic Kitty placement that omits
        // `c=`/`r=` (what `kitten icat` emits when the host answered its probe
        // as graphics-capable) is then sized via `divCeil(image_px, 0)` and
        // collapses to a 0x0 grid, dropping the image. Resizing to the same
        // geometry with a non-zero cell size updates the pixel metrics without
        // otherwise perturbing the grid.
        if let Err(error) = terminal.apply_cell_pixels() {
            // SAFETY: raw was successfully allocated above.
            unsafe { ffi::ghostty_terminal_free(raw) };
            return Err(error);
        }
        Ok(terminal)
    }

    /// Pushes `cell_pixels` into libghostty's `width_px`/`height_px`. The C
    /// resize wrapper updates the pixel metrics even when the grid is
    /// unchanged, so this is a safe no-op for the grid itself.
    fn apply_cell_pixels(&self) -> Result<(), GhosttyError> {
        checked(unsafe {
            ffi::ghostty_terminal_resize(
                self.raw,
                self.size.columns,
                self.size.rows,
                self.cell_pixels.0,
                self.cell_pixels.1,
            )
        })
    }

    fn full_damage(&self) -> Vec<DirtyRegion> {
        vec![DirtyRegion {
            column: 0,
            row: 0,
            width: self.size.columns,
            height: self.size.rows,
        }]
    }

    fn mode(&self, number: u16) -> bool {
        let mut enabled = false;
        // DEC private modes have no high ANSI bit in GhosttyMode.
        (unsafe { ffi::ghostty_terminal_mode_get(self.raw, number, &mut enabled) } == ffi::SUCCESS)
            && enabled
    }

    fn color(&self, color: ffi::StyleColor) -> Option<TerminalColor> {
        match color.tag {
            ffi::STYLE_COLOR_PALETTE => {
                Some(TerminalColor::Indexed(unsafe { color.value.palette }))
            }
            ffi::STYLE_COLOR_RGB => {
                let rgb = unsafe { color.value.rgb };
                Some(TerminalColor::Rgb(rgb.r, rgb.g, rgb.b))
            }
            _ => None,
        }
    }

    fn graphics_snapshot(&self) -> Result<Vec<KittyGraphicsEvent>, GhosttyError> {
        let mut events = vec![KittyGraphicsEvent {
            action: KittyAction::Snapshot,
            image_id: None,
            placement_id: None,
            columns: None,
            rows: None,
            payload: Vec::new(),
            image_width: 0,
            image_height: 0,
            format: 0,
            column: 0,
            row: 0,
            source_x: 0,
            source_y: 0,
            source_width: 0,
            source_height: 0,
            z: 0,
        }];
        let mut graphics: ffi::KittyGraphics = ptr::null_mut();
        checked(unsafe {
            ffi::ghostty_terminal_get(
                self.raw,
                ffi::DATA_KITTY_GRAPHICS,
                (&mut graphics as *mut ffi::KittyGraphics).cast(),
            )
        })?;
        if graphics.is_null() {
            return Ok(events);
        }
        let mut iterator: ffi::KittyPlacementIterator = ptr::null_mut();
        checked(unsafe {
            ffi::ghostty_kitty_graphics_placement_iterator_new(ptr::null(), &mut iterator)
        })?;
        let result = checked(unsafe {
            ffi::ghostty_kitty_graphics_get(
                graphics,
                ffi::KITTY_GRAPHICS_PLACEMENT_ITERATOR,
                (&mut iterator as *mut ffi::KittyPlacementIterator).cast(),
            )
        });
        if let Err(error) = result {
            unsafe { ffi::ghostty_kitty_graphics_placement_iterator_free(iterator) };
            return Err(error);
        }
        let mut virtual_placements = Vec::new();
        while unsafe { ffi::ghostty_kitty_graphics_placement_next(iterator) } {
            let mut image_id = 0_u32;
            let mut placement_id = 0_u32;
            let mut virtual_placement = false;
            let mut z = 0_i32;
            checked(unsafe {
                ffi::ghostty_kitty_graphics_placement_get(
                    iterator,
                    ffi::KITTY_PLACEMENT_IMAGE_ID,
                    (&mut image_id as *mut u32).cast(),
                )
            })?;
            checked(unsafe {
                ffi::ghostty_kitty_graphics_placement_get(
                    iterator,
                    ffi::KITTY_PLACEMENT_ID,
                    (&mut placement_id as *mut u32).cast(),
                )
            })?;
            checked(unsafe {
                ffi::ghostty_kitty_graphics_placement_get(
                    iterator,
                    ffi::KITTY_PLACEMENT_VIRTUAL,
                    (&mut virtual_placement as *mut bool).cast(),
                )
            })?;
            checked(unsafe {
                ffi::ghostty_kitty_graphics_placement_get(
                    iterator,
                    ffi::KITTY_PLACEMENT_Z,
                    (&mut z as *mut i32).cast(),
                )
            })?;
            if virtual_placement {
                let mut columns = 0_u32;
                let mut rows = 0_u32;
                checked(unsafe {
                    ffi::ghostty_kitty_graphics_placement_get(
                        iterator,
                        ffi::KITTY_PLACEMENT_COLUMNS,
                        (&mut columns as *mut u32).cast(),
                    )
                })?;
                checked(unsafe {
                    ffi::ghostty_kitty_graphics_placement_get(
                        iterator,
                        ffi::KITTY_PLACEMENT_ROWS,
                        (&mut rows as *mut u32).cast(),
                    )
                })?;
                virtual_placements.push(VirtualPlacement {
                    image_id,
                    placement_id,
                    columns,
                    rows,
                    z,
                });
                continue;
            }
            let image = unsafe { ffi::ghostty_kitty_graphics_image(graphics, image_id) };
            if image.is_null() {
                continue;
            }
            let mut width = 0_u32;
            let mut height = 0_u32;
            let mut format = 0_i32;
            let mut data_ptr: *const u8 = ptr::null();
            let mut data_len = 0_usize;
            checked(unsafe {
                ffi::ghostty_kitty_graphics_image_get(
                    image,
                    ffi::KITTY_IMAGE_WIDTH,
                    (&mut width as *mut u32).cast(),
                )
            })?;
            checked(unsafe {
                ffi::ghostty_kitty_graphics_image_get(
                    image,
                    ffi::KITTY_IMAGE_HEIGHT,
                    (&mut height as *mut u32).cast(),
                )
            })?;
            checked(unsafe {
                ffi::ghostty_kitty_graphics_image_get(
                    image,
                    ffi::KITTY_IMAGE_FORMAT,
                    (&mut format as *mut i32).cast(),
                )
            })?;
            checked(unsafe {
                ffi::ghostty_kitty_graphics_image_get(
                    image,
                    ffi::KITTY_IMAGE_DATA_PTR,
                    (&mut data_ptr as *mut *const u8).cast(),
                )
            })?;
            checked(unsafe {
                ffi::ghostty_kitty_graphics_image_get(
                    image,
                    ffi::KITTY_IMAGE_DATA_LEN,
                    (&mut data_len as *mut usize).cast(),
                )
            })?;
            let mut info = ffi::KittyRenderInfo {
                size: mem::size_of::<ffi::KittyRenderInfo>(),
                ..Default::default()
            };
            checked(unsafe {
                ffi::ghostty_kitty_graphics_placement_render_info(
                    iterator, image, self.raw, &mut info,
                )
            })?;
            if !info.viewport_visible {
                continue;
            }
            let payload = if data_len == 0 {
                Vec::new()
            } else {
                unsafe { slice::from_raw_parts(data_ptr, data_len) }.to_vec()
            };
            events.push(KittyGraphicsEvent {
                action: KittyAction::TransmitAndDisplay,
                image_id: Some(image_id),
                placement_id: Some(placement_id),
                columns: u16::try_from(info.grid_cols).ok(),
                rows: u16::try_from(info.grid_rows).ok(),
                payload,
                image_width: width,
                image_height: height,
                format: format as u8,
                column: info.viewport_col,
                row: info.viewport_row,
                source_x: info.source_x,
                source_y: info.source_y,
                source_width: info.source_width,
                source_height: info.source_height,
                z,
            });
        }
        unsafe { ffi::ghostty_kitty_graphics_placement_iterator_free(iterator) };
        self.append_virtual_placements(graphics, &virtual_placements, &mut events)?;
        Ok(events)
    }

    fn append_virtual_placements(
        &self,
        graphics: ffi::KittyGraphics,
        specs: &[VirtualPlacement],
        events: &mut Vec<KittyGraphicsEvent>,
    ) -> Result<(), GhosttyError> {
        if specs.is_empty() {
            return Ok(());
        }
        let mut cells_by_image = HashMap::<u32, Vec<VirtualCell>>::new();
        for row in 0..self.size.rows {
            for column in 0..self.size.columns {
                let cell = self.get_cell(column, row)?;
                let mut chars = cell.text.chars();
                if chars.next() != Some(KITTY_UNICODE_PLACEHOLDER) {
                    continue;
                }
                let image_low = match cell.foreground {
                    Some(TerminalColor::Indexed(value)) => u32::from(value),
                    Some(TerminalColor::Rgb(r, g, b)) => {
                        (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b)
                    }
                    None => 0,
                };
                let image_row = chars.next().and_then(kitty_diacritic_index).unwrap_or(0);
                let image_column = chars.next().and_then(kitty_diacritic_index).unwrap_or(0);
                let image_high = chars.next().and_then(kitty_diacritic_index).unwrap_or(0);
                let image_id = image_low | (image_high << 24);
                if specs.iter().any(|spec| spec.image_id == image_id) {
                    cells_by_image
                        .entry(image_id)
                        .or_default()
                        .push(VirtualCell {
                            column,
                            row,
                            image_column,
                            image_row,
                        });
                }
            }
        }

        // Placeholder cells only identify an image, not a placement. Match the
        // first virtual placement as before, but consolidate its cells before
        // handing them to the common host clipping/emission path.
        let mut seen_images = HashSet::new();
        for spec in specs {
            if !seen_images.insert(spec.image_id) {
                continue;
            }
            let Some(cells) = cells_by_image.get_mut(&spec.image_id) else {
                continue;
            };
            cells.retain(|cell| {
                cell.image_column < spec.columns.max(1) && cell.image_row < spec.rows.max(1)
            });
            let groups = consolidate_virtual_cells(cells);
            if groups.is_empty() {
                continue;
            }
            let image = unsafe { ffi::ghostty_kitty_graphics_image(graphics, spec.image_id) };
            if image.is_null() {
                continue;
            }
            let mut width = 0_u32;
            let mut height = 0_u32;
            let mut format = 0_i32;
            let mut data_ptr: *const u8 = ptr::null();
            let mut data_len = 0_usize;
            for (key, out) in [
                (ffi::KITTY_IMAGE_WIDTH, (&mut width as *mut u32).cast()),
                (ffi::KITTY_IMAGE_HEIGHT, (&mut height as *mut u32).cast()),
                (ffi::KITTY_IMAGE_FORMAT, (&mut format as *mut i32).cast()),
                (
                    ffi::KITTY_IMAGE_DATA_PTR,
                    (&mut data_ptr as *mut *const u8).cast(),
                ),
                (
                    ffi::KITTY_IMAGE_DATA_LEN,
                    (&mut data_len as *mut usize).cast(),
                ),
            ] {
                checked(unsafe { ffi::ghostty_kitty_graphics_image_get(image, key, out) })?;
            }
            let payload = if data_len == 0 {
                Vec::new()
            } else {
                unsafe { slice::from_raw_parts(data_ptr, data_len) }.to_vec()
            };
            for group in groups {
                let source_x = scale(group.image_column, width, spec.columns);
                let source_y = scale(group.image_row, height, spec.rows);
                let source_width = scale(
                    group.image_column + u32::from(group.columns),
                    width,
                    spec.columns,
                )
                .saturating_sub(source_x);
                let source_height =
                    scale(group.image_row + u32::from(group.rows), height, spec.rows)
                        .saturating_sub(source_y);
                events.push(KittyGraphicsEvent {
                    action: KittyAction::TransmitAndDisplay,
                    image_id: Some(spec.image_id),
                    placement_id: Some(spec.placement_id.wrapping_add(
                        1 + u32::from(group.row) * u32::from(self.size.columns)
                            + u32::from(group.column),
                    )),
                    columns: Some(group.columns),
                    rows: Some(group.rows),
                    payload: payload.clone(),
                    image_width: width,
                    image_height: height,
                    format: format as u8,
                    column: i32::from(group.column),
                    row: i32::from(group.row),
                    source_x,
                    source_y,
                    source_width,
                    source_height,
                    z: spec.z,
                });
            }
        }
        Ok(())
    }

    fn get_cell(&self, column: u16, row: u16) -> Result<TerminalCell, GhosttyError> {
        let point = ffi::Point {
            tag: 1, // GHOSTTY_POINT_TAG_VIEWPORT
            value: ffi::PointValue {
                coordinate: ffi::PointCoordinate {
                    x: column,
                    y: u32::from(row),
                },
            },
        };
        let mut grid_ref = ffi::GridRef {
            size: mem::size_of::<ffi::GridRef>(),
            ..Default::default()
        };
        // SAFETY: output structs use the exact pinned C layout and size field.
        checked(unsafe { ffi::ghostty_terminal_grid_ref(self.raw, point, &mut grid_ref) })?;

        let mut required = 0;
        // SAFETY: null buffer with zero capacity is the documented size query.
        let result = unsafe {
            ffi::ghostty_grid_ref_graphemes(&grid_ref, ptr::null_mut(), 0, &mut required)
        };
        if result != ffi::SUCCESS && result != ffi::OUT_OF_SPACE {
            return Err(GhosttyError(result));
        }
        let mut codepoints = vec![0_u32; required];
        if required != 0 {
            // SAFETY: codepoints has the capacity reported by the first call.
            checked(unsafe {
                ffi::ghostty_grid_ref_graphemes(
                    &grid_ref,
                    codepoints.as_mut_ptr(),
                    codepoints.len(),
                    &mut required,
                )
            })?;
            codepoints.truncate(required);
        }
        let text = codepoints
            .into_iter()
            .filter_map(char::from_u32)
            .collect::<String>();

        let mut style = ffi::Style {
            size: mem::size_of::<ffi::Style>(),
            ..Default::default()
        };
        checked(unsafe { ffi::ghostty_grid_ref_style(&grid_ref, &mut style) })?;
        let mut raw_cell = 0;
        checked(unsafe { ffi::ghostty_grid_ref_cell(&grid_ref, &mut raw_cell) })?;
        let mut wide = 0;
        checked(unsafe {
            ffi::ghostty_cell_get(
                raw_cell,
                ffi::CELL_DATA_WIDE,
                (&mut wide as *mut i32).cast(),
            )
        })?;
        let width = match wide {
            ffi::WIDE => 2,
            ffi::SPACER_TAIL | ffi::SPACER_HEAD => 0,
            _ => 1,
        };

        Ok(TerminalCell {
            text,
            attributes: CellAttributes {
                bold: style.bold,
                italic: style.italic,
                underlined: style.underline != 0,
                inverse: style.inverse,
            },
            foreground: self.color(style.fg_color),
            background: self.color(style.bg_color),
            width,
        })
    }
}

fn consolidate_virtual_cells(cells: &mut [VirtualCell]) -> Vec<VirtualCellGroup> {
    if cells.is_empty() {
        return Vec::new();
    }
    cells.sort_unstable_by_key(|cell| (cell.row, cell.column));
    let first = cells[0];
    let min_column = cells.iter().map(|cell| cell.column).min().unwrap();
    let max_column = cells.iter().map(|cell| cell.column).max().unwrap();
    let min_row = first.row;
    let max_row = cells.last().unwrap().row;
    let columns = max_column - min_column + 1;
    let rows = max_row - min_row + 1;
    let rectangular = first.column == min_column
        && cells.len() == usize::from(columns) * usize::from(rows)
        && cells.iter().enumerate().all(|(index, cell)| {
            let column_offset = (index % usize::from(columns)) as u16;
            let row_offset = (index / usize::from(columns)) as u16;
            cell.column == first.column + column_offset
                && cell.row == first.row + row_offset
                && cell.image_column == first.image_column + u32::from(column_offset)
                && cell.image_row == first.image_row + u32::from(row_offset)
        });
    if rectangular {
        return vec![VirtualCellGroup {
            column: first.column,
            row: first.row,
            image_column: first.image_column,
            image_row: first.image_row,
            columns,
            rows,
        }];
    }

    let mut groups: Vec<VirtualCellGroup> = Vec::new();
    for cell in cells.iter().copied() {
        if let Some(run) = groups.last_mut() {
            if run.row == cell.row
                && run.column + run.columns == cell.column
                && run.image_row == cell.image_row
                && run.image_column + u32::from(run.columns) == cell.image_column
            {
                run.columns += 1;
                continue;
            }
        }
        groups.push(VirtualCellGroup {
            column: cell.column,
            row: cell.row,
            image_column: cell.image_column,
            image_row: cell.image_row,
            columns: 1,
            rows: 1,
        });
    }
    groups
}

fn kitty_diacritic_index(codepoint: char) -> Option<u32> {
    let map = KITTY_DIACRITICS.get_or_init(|| {
        let source =
            include_str!("../../vendor/libghostty-vt/src/terminal/kitty/graphics_unicode.zig");
        let mut result = HashMap::new();
        let mut in_table = false;
        for line in source.lines().map(str::trim) {
            if line.starts_with("const diacritics:") {
                in_table = true;
                continue;
            }
            if !in_table {
                continue;
            }
            if line == "};" {
                break;
            }
            if let Some(hex) = line.strip_prefix("0x").and_then(|v| v.strip_suffix(',')) {
                if let Ok(value) = u32::from_str_radix(hex, 16) {
                    if let Some(character) = char::from_u32(value) {
                        result.insert(character, result.len() as u32);
                    }
                }
            }
        }
        result
    });
    map.get(&codepoint).copied()
}

fn scale(value: u32, source: u32, destination: u32) -> u32 {
    (u64::from(value) * u64::from(source) / u64::from(destination.max(1))) as u32
}

impl Drop for GhosttyTerminal {
    fn drop(&mut self) {
        // SAFETY: raw is uniquely owned and remains live until this drop.
        unsafe { ffi::ghostty_terminal_free(self.raw) };
    }
}

impl TerminalCore for GhosttyTerminal {
    type Error = GhosttyError;

    fn feed(&mut self, bytes: &[u8]) -> Result<TerminalUpdate, Self::Error> {
        // SAFETY: bytes remains live for the synchronous parser call.
        unsafe { ffi::ghostty_terminal_vt_write(self.raw, bytes.as_ptr(), bytes.len()) };
        let replies = mem::take(&mut self.callbacks.replies);
        Ok(TerminalUpdate {
            dirty: if bytes.is_empty() {
                Vec::new()
            } else {
                self.full_damage()
            },
            replies,
            graphics: self.graphics_snapshot()?,
        })
    }

    fn resize(&mut self, size: GridSize) -> Result<TerminalUpdate, Self::Error> {
        if size.columns == 0 || size.rows == 0 {
            return Err(GhosttyError(-2));
        }
        checked(unsafe {
            ffi::ghostty_terminal_resize(
                self.raw,
                size.columns,
                size.rows,
                self.cell_pixels.0,
                self.cell_pixels.1,
            )
        })?;
        self.size = size;
        Ok(TerminalUpdate {
            dirty: self.full_damage(),
            replies: mem::take(&mut self.callbacks.replies),
            graphics: self.graphics_snapshot()?,
        })
    }

    fn grid_size(&self) -> GridSize {
        self.size
    }

    fn cell(&self, column: u16, row: u16) -> Option<TerminalCell> {
        (column < self.size.columns && row < self.size.rows)
            .then(|| self.get_cell(column, row).ok())
            .flatten()
            .map(|mut cell| {
                // Unicode placeholders are graphics metadata, never printable text.
                // Keep fallback mode clean as well as avoiding glyphs over images.
                if cell.text.starts_with(KITTY_UNICODE_PLACEHOLDER) {
                    cell.text.clear();
                }
                cell
            })
    }

    fn cursor(&self) -> Option<CursorState> {
        let mut column = 0_u16;
        let mut row = 0_u16;
        let mut visible = false;
        let success = unsafe {
            ffi::ghostty_terminal_get(
                self.raw,
                ffi::DATA_CURSOR_X,
                (&mut column as *mut u16).cast(),
            ) == ffi::SUCCESS
                && ffi::ghostty_terminal_get(
                    self.raw,
                    ffi::DATA_CURSOR_Y,
                    (&mut row as *mut u16).cast(),
                ) == ffi::SUCCESS
                && ffi::ghostty_terminal_get(
                    self.raw,
                    ffi::DATA_CURSOR_VISIBLE,
                    (&mut visible as *mut bool).cast(),
                ) == ffi::SUCCESS
        };
        success.then_some(CursorState {
            column,
            row,
            visible,
        })
    }

    fn modes(&self) -> TerminalModes {
        let mouse_tracking = if self.mode(1003) {
            MouseTracking::AnyEvent
        } else if self.mode(1002) {
            MouseTracking::ButtonEvent
        } else if self.mode(9) || self.mode(1000) {
            MouseTracking::X10
        } else {
            MouseTracking::None
        };
        let mouse_encoding = if self.mode(1016) {
            MouseEncoding::SgrPixels
        } else if self.mode(1006) {
            MouseEncoding::Sgr
        } else if self.mode(1005) {
            MouseEncoding::Utf8
        } else {
            MouseEncoding::X10
        };
        let mut active_screen = 0;
        let alternate_screen = unsafe {
            ffi::ghostty_terminal_get(
                self.raw,
                ffi::DATA_ACTIVE_SCREEN,
                (&mut active_screen as *mut i32).cast(),
            )
        } == ffi::SUCCESS
            && active_screen == ffi::SCREEN_ALTERNATE;

        TerminalModes {
            mouse_tracking,
            mouse_encoding,
            bracketed_paste: self.mode(2004),
            application_cursor: self.mode(1),
            application_keypad: self.mode(66),
            focus_reporting: self.mode(1004),
            alternate_screen,
            synchronized_output: self.mode(2026),
        }
    }
}
