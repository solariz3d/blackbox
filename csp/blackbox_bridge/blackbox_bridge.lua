--[[
  BLACKBOX Bridge — CSP Lua app
  ----------------------------------------------------------------------------
  Mirrors CSP extended-physics values that are NOT present in Assetto Corsa's
  stock shared memory (acpmf_physics / acpmf_graphics / acpmf_static) out to a
  named Windows file mapping, so an external process can read them.

  Published mapping:  Local\AcTools.CSP.Limited.BlackboxBridge.v0
  Layout:             see BLACKBOX_LAYOUT below (raw C string — see NOTE 1)
  Rate:               graphics rate (~60-165 Hz), one publish per script.update

  NOTE 1 — the layout MUST be a raw C string, not an ac.StructItem table.
  Table layouts are reordered by CSP (packing size descending, then
  alphabetically, then bin-packed), which would silently desync the external
  #[repr(C)] struct. A raw string is emitted verbatim. Do not "tidy" this into
  a table.

  NOTE 2 — persist = true is required. Without it LuaJIT's GC can unmap the
  region out from under the reader.

  NOTE 3 — this app NEVER writes into the Assetto Corsa install and never
  modifies any car. It only reads sim state and writes to shared memory.
--]]

local MMF_NAME = 'AcTools.CSP.Limited.BlackboxBridge.v0'

local INPUT_COUNT = 20
local FORMAT_VERSION = 1
local MAGIC = 0x30584242 -- 'BBX0' as little-endian u32

-- Field order is hand-tuned so that natural C alignment introduces ZERO
-- implicit padding. Offsets (bytes):
--   magic 0, version 4, seq 8, frame 12, switchMask 16, statusFlags 20,
--   carIndex 24, inputCount 28, simTimeMs 32 (8-aligned), inputs 40..119
--   total = 120
-- If you add a field, keep 8-byte types 8-aligned and re-check the Rust struct.
local BLACKBOX_LAYOUT = [[
  uint32_t magic;
  uint32_t version;
  uint32_t seq;
  uint32_t frame;
  uint32_t switchMask;
  uint32_t statusFlags;
  uint32_t carIndex;
  uint32_t inputCount;
  double   simTimeMs;
  float    inputs[20];
]]

-- statusFlags bits ----------------------------------------------------------
local F_PHYS_STATE    = 0x01 -- ac.getCarPhysics(0) returned non-nil
local F_PHYS_AVAIL    = 0x02 -- carPhysics.isAvailable
local F_EXT_PHYSICS   = 0x04 -- car.extendedPhysics  (CSP extended physics on)
local F_CAR_PHYS_OK   = 0x08 -- car.physicsAvailable (not a replay/remote car)
local F_REPLAY        = 0x10 -- sim.isReplayActive
local F_PAUSED        = 0x20 -- sim.isPaused
local F_EVER_NONZERO  = 0x40 -- sticky: some input has been non-zero since load

local CAR_INDEX = 0

-- Open the mapping ----------------------------------------------------------
local sm = ac.writeMemoryMappedFile(MMF_NAME, BLACKBOX_LAYOUT, true)

local everNonZero = false
local lastError = nil

if sm then
  sm.magic      = MAGIC
  sm.version    = FORMAT_VERSION
  sm.carIndex   = CAR_INDEX
  sm.inputCount = INPUT_COUNT
  sm.seq        = 0
  sm.frame      = 0
else
  lastError = 'ac.writeMemoryMappedFile returned nil'
  ac.error('[blackbox_bridge] failed to open mapping: ' .. MMF_NAME)
end

-- Per-frame publish ---------------------------------------------------------
function script.update(dt)
  if not sm then return end

  local sim  = ac.getSim()
  local car  = ac.getCar(CAR_INDEX)
  local phys = ac.getCarPhysics(CAR_INDEX)

  local flags = 0
  if sim then
    if sim.isReplayActive then flags = flags + F_REPLAY end
    if sim.isPaused       then flags = flags + F_PAUSED end
  end
  if car then
    if car.extendedPhysics   then flags = flags + F_EXT_PHYSICS end
    if car.physicsAvailable  then flags = flags + F_CAR_PHYS_OK end
  end
  if phys then
    flags = flags + F_PHYS_STATE
    if phys.isAvailable then flags = flags + F_PHYS_AVAIL end
  end

  -- seqlock: odd while writing
  sm.seq = sm.seq + 1

  local mask = 0
  if phys then
    local sci = phys.scriptControllerInputs
    for i = 0, INPUT_COUNT - 1 do
      local v = sci[i] or 0
      sm.inputs[i] = v
      if v > 0.5 then mask = mask + bit.lshift(1, i) end
      if v ~= 0 then everNonZero = true end
    end
  else
    -- Publish an explicit zero frame rather than stale data, so a consumer can
    -- tell "bridge alive, physics unavailable" from "bridge dead".
    for i = 0, INPUT_COUNT - 1 do
      sm.inputs[i] = 0
    end
  end

  if everNonZero then flags = flags + F_EVER_NONZERO end

  sm.switchMask  = mask
  sm.statusFlags = flags
  sm.simTimeMs   = sim and sim.time or os.preciseClock() * 1000
  sm.frame       = sm.frame + 1

  -- publish
  sm.seq = sm.seq + 1
end

-- Clear the sentinel on unload so a reader can tell "bridge gone" from "bridge
-- alive but idle". ac.onRelease is the correct hook (verified against shipped
-- apps: CspDebug.lua, MumbleWrapper.lua) — there is no script.onRelease.
ac.onRelease(function()
  if sm then
    sm.statusFlags = 0
    sm.magic = 0
  end
end)

-- Diagnostic window ---------------------------------------------------------
-- Doubles as the verification UI: if these numbers move, the bridge works.
local function flagLabel(flags, bitv, name)
  local on = bit.band(flags, bitv) ~= 0
  ui.textColored(name .. ': ' .. (on and 'yes' or 'no'),
    on and rgbm(0.5, 1, 0.5, 1) or rgbm(1, 0.55, 0.55, 1))
end

function windowMain()
  if not sm then
    ui.textColored('MAPPING FAILED', rgbm(1, 0.4, 0.4, 1))
    ui.text(lastError or 'unknown error')
    return
  end

  ui.text('Local\\' .. MMF_NAME)
  ui.text(string.format('seq %d   frame %d', sm.seq, sm.frame))
  ui.text(string.format('mask 0x%05X', sm.switchMask))
  ui.separator()

  local f = sm.statusFlags
  flagLabel(f, F_PHYS_STATE,   'getCarPhysics(0)')
  flagLabel(f, F_PHYS_AVAIL,   'physics.isAvailable')
  flagLabel(f, F_EXT_PHYSICS,  'car.extendedPhysics')
  flagLabel(f, F_CAR_PHYS_OK,  'car.physicsAvailable')
  flagLabel(f, F_EVER_NONZERO, 'any input seen non-zero')
  if bit.band(f, F_REPLAY) ~= 0 then ui.textColored('REPLAY ACTIVE', rgbm(1, 0.8, 0.3, 1)) end
  if bit.band(f, F_PAUSED) ~= 0 then ui.textColored('PAUSED', rgbm(1, 0.8, 0.3, 1)) end
  ui.separator()

  for i = 0, INPUT_COUNT - 1 do
    local v = sm.inputs[i]
    local hot = v > 0.5
    ui.textColored(string.format('[%2d] %8.3f', i, v),
      hot and rgbm(1, 1, 0.4, 1) or rgbm(0.75, 0.75, 0.75, 1))
  end
end
