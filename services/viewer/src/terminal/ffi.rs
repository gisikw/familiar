//! Minimal handwritten declarations for the pinned libghostty-vt C API.

use std::ffi::{c_int, c_void};

pub type ResultCode = c_int;
pub type Terminal = *mut c_void;
pub type KittyGraphics = *mut c_void;
pub type KittyImage = *const c_void;
pub type KittyPlacementIterator = *mut c_void;
pub const SUCCESS: ResultCode = 0;
pub const OUT_OF_SPACE: ResultCode = -3;

pub const OPT_USERDATA: c_int = 0;
pub const OPT_WRITE_PTY: c_int = 1;
pub const OPT_DEVICE_ATTRIBUTES: c_int = 8;
pub const OPT_KITTY_IMAGE_STORAGE_LIMIT: c_int = 15;
pub const OPT_APC_MAX_BYTES: c_int = 19;
pub const OPT_APC_MAX_BYTES_KITTY: c_int = 20;

pub const DATA_CURSOR_X: c_int = 3;
pub const DATA_CURSOR_Y: c_int = 4;
pub const DATA_ACTIVE_SCREEN: c_int = 6;
pub const DATA_CURSOR_VISIBLE: c_int = 7;
pub const DATA_KITTY_GRAPHICS: c_int = 30;
pub const SCREEN_ALTERNATE: c_int = 1;

pub const KITTY_GRAPHICS_PLACEMENT_ITERATOR: c_int = 1;
pub const KITTY_PLACEMENT_IMAGE_ID: c_int = 1;
pub const KITTY_PLACEMENT_ID: c_int = 2;
pub const KITTY_PLACEMENT_VIRTUAL: c_int = 3;
pub const KITTY_PLACEMENT_COLUMNS: c_int = 10;
pub const KITTY_PLACEMENT_ROWS: c_int = 11;
pub const KITTY_PLACEMENT_Z: c_int = 12;
pub const KITTY_IMAGE_WIDTH: c_int = 3;
pub const KITTY_IMAGE_HEIGHT: c_int = 4;
pub const KITTY_IMAGE_FORMAT: c_int = 5;
pub const KITTY_IMAGE_DATA_PTR: c_int = 7;
pub const KITTY_IMAGE_DATA_LEN: c_int = 8;

pub const CELL_DATA_CONTENT_TAG: c_int = 2;
pub const CELL_DATA_WIDE: c_int = 3;
pub const CELL_DATA_COLOR_PALETTE: c_int = 10;
pub const CELL_DATA_COLOR_RGB: c_int = 11;
pub const WIDE: c_int = 1;
pub const SPACER_TAIL: c_int = 2;
pub const SPACER_HEAD: c_int = 3;

// GhosttyCellContentTag values.
pub const CELL_CONTENT_BG_COLOR_PALETTE: c_int = 2;
pub const CELL_CONTENT_BG_COLOR_RGB: c_int = 3;

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

#[repr(C)]
#[derive(Default)]
pub struct SysImage {
    pub width: u32,
    pub height: u32,
    pub data: *mut u8,
    pub data_len: usize,
}

#[repr(C)]
#[derive(Default)]
pub struct KittyRenderInfo {
    pub size: usize,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub grid_cols: u32,
    pub grid_rows: u32,
    pub viewport_col: i32,
    pub viewport_row: i32,
    pub viewport_visible: bool,
    pub source_x: u32,
    pub source_y: u32,
    pub source_width: u32,
    pub source_height: u32,
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
    pub fn ghostty_sys_set(option: c_int, value: *const c_void) -> ResultCode;
    pub fn ghostty_alloc(allocator: *const c_void, len: usize) -> *mut u8;
    pub fn ghostty_kitty_graphics_get(
        graphics: KittyGraphics,
        data: c_int,
        out: *mut c_void,
    ) -> ResultCode;
    pub fn ghostty_kitty_graphics_image(graphics: KittyGraphics, image_id: u32) -> KittyImage;
    pub fn ghostty_kitty_graphics_image_get(
        image: KittyImage,
        data: c_int,
        out: *mut c_void,
    ) -> ResultCode;
    pub fn ghostty_kitty_graphics_placement_iterator_new(
        allocator: *const c_void,
        out: *mut KittyPlacementIterator,
    ) -> ResultCode;
    pub fn ghostty_kitty_graphics_placement_iterator_free(iterator: KittyPlacementIterator);
    pub fn ghostty_kitty_graphics_placement_next(iterator: KittyPlacementIterator) -> bool;
    pub fn ghostty_kitty_graphics_placement_get(
        iterator: KittyPlacementIterator,
        data: c_int,
        out: *mut c_void,
    ) -> ResultCode;
    pub fn ghostty_kitty_graphics_placement_render_info(
        iterator: KittyPlacementIterator,
        image: KittyImage,
        terminal: Terminal,
        out: *mut KittyRenderInfo,
    ) -> ResultCode;
}
