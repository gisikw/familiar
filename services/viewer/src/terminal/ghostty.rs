//! Safe, renderer-oriented adapter over the vendored libghostty-vt C API.

use super::ffi;
use super::{
    CellAttributes, DirtyRegion, GridSize, MouseEncoding, MouseTracking, TerminalCell,
    TerminalCore, TerminalModes, TerminalUpdate,
};
use std::ffi::c_void;
use std::fmt;
use std::mem;
use std::ptr;
use std::slice;

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
    callbacks: Box<CallbackState>,
    palette: [ffi::ColorRgb; 256],
}

impl GhosttyTerminal {
    pub fn new(size: GridSize) -> Result<Self, GhosttyError> {
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
            callbacks: Box::default(),
            palette: [ffi::ColorRgb::default(); 256],
        };
        // SAFETY: the palette has exactly the 256 entries required by the API.
        unsafe { ffi::ghostty_color_palette_default(terminal.palette.as_mut_ptr()) };
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
        };
        if let Err(error) = setup {
            // SAFETY: raw was successfully allocated above.
            unsafe { ffi::ghostty_terminal_free(raw) };
            return Err(error);
        }
        Ok(terminal)
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

    fn color(&self, color: ffi::StyleColor) -> Option<[u8; 3]> {
        let rgb = match color.tag {
            ffi::STYLE_COLOR_PALETTE => self.palette[unsafe { color.value.palette } as usize],
            ffi::STYLE_COLOR_RGB => unsafe { color.value.rgb },
            _ => return None,
        };
        Some([rgb.r, rgb.g, rgb.b])
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
            foreground_rgb: self.color(style.fg_color),
            background_rgb: self.color(style.bg_color),
            width,
        })
    }
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
        Ok(TerminalUpdate {
            dirty: if bytes.is_empty() {
                Vec::new()
            } else {
                self.full_damage()
            },
            replies: mem::take(&mut self.callbacks.replies),
            graphics: Vec::new(),
        })
    }

    fn resize(&mut self, size: GridSize) -> Result<TerminalUpdate, Self::Error> {
        if size.columns == 0 || size.rows == 0 {
            return Err(GhosttyError(-2));
        }
        checked(unsafe { ffi::ghostty_terminal_resize(self.raw, size.columns, size.rows, 1, 1) })?;
        self.size = size;
        Ok(TerminalUpdate {
            dirty: self.full_damage(),
            replies: mem::take(&mut self.callbacks.replies),
            graphics: Vec::new(),
        })
    }

    fn grid_size(&self) -> GridSize {
        self.size
    }

    fn cell(&self, column: u16, row: u16) -> Option<TerminalCell> {
        (column < self.size.columns && row < self.size.rows)
            .then(|| self.get_cell(column, row).ok())
            .flatten()
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
