//! Minimal handwritten declarations for the pinned libghostty-vt C API.

use std::ffi::{c_int, c_void};

pub type ResultCode = c_int;
pub type Terminal = *mut c_void;
pub const SUCCESS: ResultCode = 0;
pub const OUT_OF_SPACE: ResultCode = -3;

pub const OPT_USERDATA: c_int = 0;
pub const OPT_WRITE_PTY: c_int = 1;
pub const OPT_DEVICE_ATTRIBUTES: c_int = 8;

pub const DATA_ACTIVE_SCREEN: c_int = 6;
pub const SCREEN_ALTERNATE: c_int = 1;

pub const CELL_DATA_WIDE: c_int = 3;
pub const WIDE: c_int = 1;
pub const SPACER_TAIL: c_int = 2;
pub const SPACER_HEAD: c_int = 3;

pub const STYLE_COLOR_PALETTE: c_int = 1;
pub const STYLE_COLOR_RGB: c_int = 2;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct TerminalOptions {
    pub cols: u16,
    pub rows: u16,
    pub max_scrollback: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ColorRgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub union StyleColorValue {
    pub palette: u8,
    pub rgb: ColorRgb,
    pub padding: u64,
}

impl Default for StyleColorValue {
    fn default() -> Self {
        Self { padding: 0 }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct StyleColor {
    pub tag: c_int,
    pub value: StyleColorValue,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Style {
    pub size: usize,
    pub fg_color: StyleColor,
    pub bg_color: StyleColor,
    pub underline_color: StyleColor,
    pub bold: bool,
    pub italic: bool,
    pub faint: bool,
    pub blink: bool,
    pub inverse: bool,
    pub invisible: bool,
    pub strikethrough: bool,
    pub overline: bool,
    pub underline: c_int,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct GridRef {
    pub size: usize,
    pub node: *mut c_void,
    pub x: u16,
    pub y: u16,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct PointCoordinate {
    pub x: u16,
    pub y: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub union PointValue {
    pub coordinate: PointCoordinate,
    pub padding: [u64; 2],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Point {
    pub tag: c_int,
    pub value: PointValue,
}

#[repr(C)]
pub struct DeviceAttributesPrimary {
    pub conformance_level: u16,
    pub features: [u16; 64],
    pub num_features: usize,
}

#[repr(C)]
pub struct DeviceAttributesSecondary {
    pub device_type: u16,
    pub firmware_version: u16,
    pub rom_cartridge: u16,
}

#[repr(C)]
pub struct DeviceAttributesTertiary {
    pub unit_id: u32,
}

#[repr(C)]
pub struct DeviceAttributes {
    pub primary: DeviceAttributesPrimary,
    pub secondary: DeviceAttributesSecondary,
    pub tertiary: DeviceAttributesTertiary,
}

unsafe extern "C" {
    pub fn ghostty_terminal_new(
        allocator: *const c_void,
        terminal: *mut Terminal,
        options: TerminalOptions,
    ) -> ResultCode;
    pub fn ghostty_terminal_free(terminal: Terminal);
    pub fn ghostty_terminal_set(
        terminal: Terminal,
        option: c_int,
        value: *const c_void,
    ) -> ResultCode;
    pub fn ghostty_terminal_vt_write(terminal: Terminal, data: *const u8, len: usize);
    pub fn ghostty_terminal_resize(
        terminal: Terminal,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> ResultCode;
    pub fn ghostty_terminal_get(terminal: Terminal, data: c_int, out: *mut c_void) -> ResultCode;
    pub fn ghostty_terminal_mode_get(terminal: Terminal, mode: u16, out: *mut bool) -> ResultCode;
    pub fn ghostty_terminal_grid_ref(
        terminal: Terminal,
        point: Point,
        out: *mut GridRef,
    ) -> ResultCode;
    pub fn ghostty_grid_ref_graphemes(
        grid_ref: *const GridRef,
        buffer: *mut u32,
        buffer_len: usize,
        out_len: *mut usize,
    ) -> ResultCode;
    pub fn ghostty_grid_ref_style(grid_ref: *const GridRef, out: *mut Style) -> ResultCode;
    pub fn ghostty_grid_ref_cell(grid_ref: *const GridRef, out: *mut u64) -> ResultCode;
    pub fn ghostty_cell_get(cell: u64, data: c_int, out: *mut c_void) -> ResultCode;
    pub fn ghostty_color_palette_default(out: *mut ColorRgb);
}
