// The flat-2d profile: the optional-module record (kit/vfx/module.js documents the contract). It is what makes `create`
// carry this folder into a flat-2d game's gf/three/ and into no other game: gf-three.json → modules.extras lists "flat"
// exactly when the spec's profile is flat-2d. The flat look, world and body declare their slots through kit/flat/slots.js, which the
// slot assembler reads in place of the stand-ins' (tools/lib/slots-lib.mjs), so slotsFor has nothing to add.
export const id = 'flat';
export const describe = 'A flat-2d game\'s look, world, picture bodies and camera (spec profile "flat-2d")';
export const uses = spec => spec?.runtime === 'three' && spec?.profile === 'flat-2d';
export const configFor = () => null;
export const files = () => [];
export const slotsFor = () => [];
