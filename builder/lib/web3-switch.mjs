// The web3 switch: tokens, shops, loot boxes and game economies (devnet only). On by default;
// GAMESFUN_WEB3=0 (or off, false, no) turns it off for the MCP server's
// web3_* and economy_* tools, the studio's Economy tab and the build loop's economy step.
const OFF = /^(0|false|no|off)$/i;

/** Is web3 on in this environment? */
export const web3On = (env = process.env) => !OFF.test(String(env.GAMESFUN_WEB3 ?? '').trim());
