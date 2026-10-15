// A look option's copy of the game, as the look step leaves it in .look/options/<id>/game: its own audio module plays
// sounds the game's list does not have. It is the loop's working copy, never the game's code.
export function start(ctx) { ctx.audio.play('shoot'); ctx.audio.play('explode-big'); }
