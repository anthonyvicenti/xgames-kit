// The games.fun loot program 0.3.2 ("Economy for Anything"): its Anchor IDL, program GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o
// on devnet. Built by `anchor idl build` (target/idl/loot.json, SHA-256 a18209d081887976014d924fbad199ed181f09064f83e0648212b1f50210d930)
// from games.fun launchpad/loot at commit 5cf40df40 (0.3.2, the cleanup, upgraded in place on devnet 2026-10-12), with doc
// comments removed. It is games.fun's own program (MIT). Both sides encode instructions and decode accounts from it.
export default {
 "address": "GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o",
 "metadata": {
  "name": "loot",
  "version": "0.3.2",
  "spec": "0.1.0",
  "description": "Economy for Anything: one program every coin of a project passes through"
 },
 "instructions": [
  {
   "name": "attach_token",
   "discriminator": [142, 89, 224, 67, 115, 211, 99, 110],
   "accounts": [
    {
     "name": "owner",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "launcher",
     "signer": true
    },
    {
     "name": "game",
     "writable": true
    },
    {
     "name": "platform"
    },
    {
     "name": "venue_a"
    },
    {
     "name": "venue_b"
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "venue",
     "type": {
      "defined": {
       "name": "Venue"
      }
     }
    },
    {
     "name": "mint",
     "type": "pubkey"
    }
   ]
  },
  {
   "name": "award",
   "discriminator": [180, 74, 165, 67, 179, 135, 27, 202],
   "accounts": [
    {
     "name": "signer",
     "writable": true,
     "signer": true
    },
    {
     "name": "game",
     "relations": [
      "hold"
     ]
    },
    {
     "name": "hold",
     "writable": true
    },
    {
     "name": "asset",
     "writable": true,
     "relations": [
      "hold"
     ]
    },
    {
     "name": "player",
     "writable": true,
     "relations": [
      "hold"
     ]
    },
    {
     "name": "to"
    },
    {
     "name": "collection"
    },
    {
     "name": "mpl_core_program",
     "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "reference",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "burn",
   "discriminator": [116, 110, 29, 56, 107, 219, 42, 93],
   "accounts": [
    {
     "name": "authority",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "pool",
     "writable": true
    },
    {
     "name": "mint",
     "writable": true
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "index",
     "type": "u8"
    },
    {
     "name": "amount",
     "type": "u64"
    },
    {
     "name": "reference",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "buy_item",
   "discriminator": [80, 82, 193, 201, 216, 27, 70, 184],
   "accounts": [
    {
     "name": "item",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [105, 116, 101, 109]
       },
       {
        "kind": "account",
        "path": "checkout.game",
        "account": "Checkout"
       },
       {
        "kind": "arg",
        "path": "item_id"
       }
      ]
     }
    },
    {
     "name": "checkout",
     "accounts": [
      {
       "name": "player",
       "writable": true,
       "signer": true
      },
      {
       "name": "game"
      },
      {
       "name": "platform"
      },
      {
       "name": "order",
       "writable": true,
       "pda": {
        "seeds": [
         {
          "kind": "const",
          "value": [111, 114, 100, 101, 114]
         },
         {
          "kind": "account",
          "path": "game"
         },
         {
          "kind": "account",
          "path": "player"
         },
         {
          "kind": "arg",
          "path": "nonce"
         }
        ]
       }
      },
      {
       "name": "escrow",
       "writable": true,
       "pda": {
        "seeds": [
         {
          "kind": "const",
          "value": [101, 115, 99, 114, 111, 119]
         },
         {
          "kind": "account",
          "path": "order"
         }
        ]
       }
      },
      {
       "name": "mint"
      },
      {
       "name": "player_token",
       "writable": true
      },
      {
       "name": "vault",
       "writable": true
      },
      {
       "name": "token_program",
       "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
      },
      {
       "name": "token_2022_program",
       "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
      },
      {
       "name": "associated_token_program",
       "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "item_id",
     "type": "u32"
    },
    {
     "name": "nonce",
     "type": "u64"
    },
    {
     "name": "max_price",
     "type": "u64"
    }
   ]
  },
  {
   "name": "buy_tickets",
   "discriminator": [48, 16, 122, 137, 24, 214, 198, 58],
   "accounts": [
    {
     "name": "player",
     "writable": true,
     "signer": true
    },
    {
     "name": "game",
     "relations": [
      "lottery"
     ]
    },
    {
     "name": "lottery",
     "writable": true
    },
    {
     "name": "player_token",
     "writable": true
    },
    {
     "name": "pot",
     "writable": true
    },
    {
     "name": "treasury",
     "writable": true
    },
    {
     "name": "mint",
     "writable": true
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "count",
     "type": "u64"
    },
    {
     "name": "max_price",
     "type": "u64"
    }
   ]
  },
  {
   "name": "call_off",
   "discriminator": [92, 176, 48, 107, 235, 52, 246, 81],
   "accounts": [
    {
     "name": "signer",
     "signer": true
    },
    {
     "name": "game",
     "relations": [
      "contest"
     ]
    },
    {
     "name": "contest",
     "writable": true
    }
   ],
   "args": []
  },
  {
   "name": "callback_lottery",
   "discriminator": [177, 95, 170, 205, 202, 136, 78, 28],
   "accounts": [
    {
     "name": "vrf_program_identity",
     "signer": true
    },
    {
     "name": "lottery",
     "writable": true
    },
    {
     "name": "ticket"
    }
   ],
   "args": [
    {
     "name": "randomness",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "callback_random",
   "discriminator": [64, 93, 248, 223, 247, 90, 38, 224],
   "accounts": [
    {
     "name": "vrf_program_identity",
     "signer": true
    },
    {
     "name": "game"
    },
    {
     "name": "reference"
    }
   ],
   "args": [
    {
     "name": "randomness",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "callback_roll",
   "discriminator": [104, 43, 141, 38, 167, 29, 52, 209],
   "accounts": [
    {
     "name": "vrf_program_identity",
     "signer": true
    },
    {
     "name": "order",
     "writable": true
    },
    {
     "name": "loot_box"
    },
    {
     "name": "ticket"
    }
   ],
   "args": [
    {
     "name": "randomness",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "claim",
   "discriminator": [62, 198, 214, 193, 213, 159, 108, 210],
   "accounts": [
    {
     "name": "game",
     "relations": [
      "contest"
     ]
    },
    {
     "name": "contest",
     "writable": true,
     "relations": [
      "entry"
     ]
    },
    {
     "name": "entry",
     "writable": true
    },
    {
     "name": "player",
     "writable": true,
     "relations": [
      "entry"
     ]
    },
    {
     "name": "pot",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [112, 111, 116]
       },
       {
        "kind": "account",
        "path": "contest"
       }
      ]
     }
    },
    {
     "name": "to",
     "writable": true
    },
    {
     "name": "mint"
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    }
   ],
   "args": []
  },
  {
   "name": "close_contest",
   "discriminator": [139, 238, 103, 40, 217, 73, 90, 72],
   "accounts": [
    {
     "name": "game",
     "relations": [
      "contest"
     ]
    },
    {
     "name": "contest",
     "writable": true
    },
    {
     "name": "opener",
     "writable": true,
     "relations": [
      "contest"
     ]
    },
    {
     "name": "mint",
     "writable": true,
     "relations": [
      "contest"
     ]
    },
    {
     "name": "pot",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [112, 111, 116]
       },
       {
        "kind": "account",
        "path": "contest"
       }
      ]
     }
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    }
   ],
   "args": []
  },
  {
   "name": "close_pool",
   "discriminator": [140, 189, 209, 23, 239, 62, 239, 11],
   "accounts": [
    {
     "name": "owner",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "pool",
     "writable": true
    },
    {
     "name": "mint",
     "writable": true
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    }
   ],
   "args": [
    {
     "name": "index",
     "type": "u8"
    }
   ]
  },
  {
   "name": "collect_fees",
   "discriminator": [164, 152, 207, 99, 30, 186, 19, 182],
   "accounts": [
    {
     "name": "admin",
     "signer": true,
     "relations": [
      "platform"
     ]
    },
    {
     "name": "platform",
     "writable": true
    },
    {
     "name": "to",
     "writable": true
    }
   ],
   "args": []
  },
  {
   "name": "craft",
   "discriminator": [161, 233, 177, 214, 243, 109, 161, 224],
   "accounts": [
    {
     "name": "player",
     "writable": true,
     "signer": true
    },
    {
     "name": "game",
     "relations": [
      "recipe"
     ]
    },
    {
     "name": "recipe"
    },
    {
     "name": "collection",
     "writable": true
    },
    {
     "name": "mpl_core_program",
     "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "version",
     "type": "u32"
    },
    {
     "name": "times",
     "type": "u64"
    }
   ]
  },
  {
   "name": "create_game",
   "discriminator": [124, 69, 75, 66, 184, 220, 72, 206],
   "accounts": [
    {
     "name": "owner",
     "writable": true,
     "signer": true
    },
    {
     "name": "game",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [103, 97, 109, 101]
       },
       {
        "kind": "account",
        "path": "collection"
       }
      ]
     }
    },
    {
     "name": "fees",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [102, 101, 101, 115]
       },
       {
        "kind": "account",
        "path": "game"
       }
      ]
     }
    },
    {
     "name": "collection"
    },
    {
     "name": "mint"
    },
    {
     "name": "treasury"
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "authority",
     "type": "pubkey"
    }
   ]
  },
  {
   "name": "decide",
   "discriminator": [123, 125, 184, 125, 249, 43, 113, 15],
   "accounts": [
    {
     "name": "authority",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game",
     "relations": [
      "contest"
     ]
    },
    {
     "name": "contest",
     "writable": true
    },
    {
     "name": "mint",
     "writable": true,
     "relations": [
      "contest"
     ]
    },
    {
     "name": "pot",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [112, 111, 116]
       },
       {
        "kind": "account",
        "path": "contest"
       }
      ]
     }
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "side",
     "type": "u8"
    },
    {
     "name": "reference",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "deposit",
   "discriminator": [242, 35, 198, 137, 82, 225, 242, 182],
   "accounts": [
    {
     "name": "depositor",
     "writable": true,
     "signer": true
    },
    {
     "name": "game"
    },
    {
     "name": "pool",
     "writable": true
    },
    {
     "name": "from",
     "writable": true
    },
    {
     "name": "mint"
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "index",
     "type": "u8"
    },
    {
     "name": "amount",
     "type": "u64"
    }
   ]
  },
  {
   "name": "draw_lottery",
   "discriminator": [17, 188, 124, 77, 90, 34, 97, 19],
   "accounts": [
    {
     "name": "payer",
     "writable": true,
     "signer": true
    },
    {
     "name": "lottery",
     "writable": true
    },
    {
     "name": "oracle_queue",
     "writable": true,
     "address": "Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh"
    },
    {
     "name": "program_identity",
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [105, 100, 101, 110, 116, 105, 116, 121]
       }
      ]
     }
    },
    {
     "name": "vrf_program",
     "address": "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"
    },
    {
     "name": "slot_hashes",
     "address": "SysvarS1otHashes111111111111111111111111111"
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": []
  },
  {
   "name": "enter",
   "discriminator": [139, 49, 209, 114, 88, 91, 77, 134],
   "accounts": [
    {
     "name": "player",
     "writable": true,
     "signer": true
    },
    {
     "name": "game",
     "relations": [
      "contest"
     ]
    },
    {
     "name": "contest",
     "writable": true
    },
    {
     "name": "entry",
     "writable": true
    },
    {
     "name": "pot",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [112, 111, 116]
       },
       {
        "kind": "account",
        "path": "contest"
       }
      ]
     }
    },
    {
     "name": "player_token",
     "writable": true
    },
    {
     "name": "mint"
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "side",
     "type": "u8"
    },
    {
     "name": "amount",
     "type": "u64"
    },
    {
     "name": "terms",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "hold",
   "discriminator": [83, 159, 208, 118, 203, 182, 239, 221],
   "accounts": [
    {
     "name": "player",
     "writable": true,
     "signer": true
    },
    {
     "name": "game"
    },
    {
     "name": "hold",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [104, 111, 108, 100]
       },
       {
        "kind": "account",
        "path": "asset"
       }
      ]
     }
    },
    {
     "name": "asset",
     "writable": true
    },
    {
     "name": "collection"
    },
    {
     "name": "mpl_core_program",
     "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "seconds",
     "type": "i64"
    },
    {
     "name": "reference",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "init_platform",
   "discriminator": [29, 22, 210, 225, 219, 114, 193, 169],
   "accounts": [
    {
     "name": "admin",
     "writable": true,
     "signer": true
    },
    {
     "name": "platform",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [112, 108, 97, 116, 102, 111, 114, 109]
       }
      ]
     }
    },
    {
     "name": "program_data"
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "fees",
     "type": {
      "defined": {
       "name": "Fees"
      }
     }
    },
    {
     "name": "partner",
     "type": "pubkey"
    }
   ]
  },
  {
   "name": "issue",
   "discriminator": [190, 1, 98, 214, 81, 99, 222, 247],
   "accounts": [
    {
     "name": "authority",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "mint",
     "writable": true
    },
    {
     "name": "to",
     "writable": true
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "amount",
     "type": "u64"
    },
    {
     "name": "reference",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "make",
   "discriminator": [138, 227, 232, 77, 223, 166, 96, 197],
   "accounts": [
    {
     "name": "authority",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game",
     "relations": [
      "item"
     ]
    },
    {
     "name": "item",
     "writable": true
    },
    {
     "name": "collection",
     "writable": true
    },
    {
     "name": "asset",
     "writable": true,
     "signer": true
    },
    {
     "name": "owner"
    },
    {
     "name": "mpl_core_program",
     "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "reference",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "open_box",
   "discriminator": [225, 220, 10, 104, 173, 151, 214, 199],
   "accounts": [
    {
     "name": "loot_box",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [98, 111, 120]
       },
       {
        "kind": "account",
        "path": "checkout.game",
        "account": "Checkout"
       },
       {
        "kind": "arg",
        "path": "box_id"
       }
      ]
     }
    },
    {
     "name": "checkout",
     "accounts": [
      {
       "name": "player",
       "writable": true,
       "signer": true
      },
      {
       "name": "game"
      },
      {
       "name": "platform"
      },
      {
       "name": "order",
       "writable": true,
       "pda": {
        "seeds": [
         {
          "kind": "const",
          "value": [111, 114, 100, 101, 114]
         },
         {
          "kind": "account",
          "path": "game"
         },
         {
          "kind": "account",
          "path": "player"
         },
         {
          "kind": "arg",
          "path": "nonce"
         }
        ]
       }
      },
      {
       "name": "escrow",
       "writable": true,
       "pda": {
        "seeds": [
         {
          "kind": "const",
          "value": [101, 115, 99, 114, 111, 119]
         },
         {
          "kind": "account",
          "path": "order"
         }
        ]
       }
      },
      {
       "name": "mint"
      },
      {
       "name": "player_token",
       "writable": true
      },
      {
       "name": "vault",
       "writable": true
      },
      {
       "name": "token_program",
       "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
      },
      {
       "name": "token_2022_program",
       "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
      },
      {
       "name": "associated_token_program",
       "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    },
    {
     "name": "oracle_queue",
     "writable": true,
     "address": "Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh"
    },
    {
     "name": "program_identity",
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [105, 100, 101, 110, 116, 105, 116, 121]
       }
      ]
     }
    },
    {
     "name": "vrf_program",
     "address": "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"
    },
    {
     "name": "slot_hashes",
     "address": "SysvarS1otHashes111111111111111111111111111"
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "box_id",
     "type": "u32"
    },
    {
     "name": "nonce",
     "type": "u64"
    },
    {
     "name": "client_seed",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    },
    {
     "name": "max_price",
     "type": "u64"
    }
   ]
  },
  {
   "name": "open_contest",
   "discriminator": [54, 94, 57, 118, 71, 166, 26, 165],
   "accounts": [
    {
     "name": "authority",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "contest",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [99, 111, 110, 116, 101, 115, 116]
       },
       {
        "kind": "account",
        "path": "game"
       },
       {
        "kind": "arg",
        "path": "id"
       }
      ]
     }
    },
    {
     "name": "mint"
    },
    {
     "name": "pot",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [112, 111, 116]
       },
       {
        "kind": "account",
        "path": "contest"
       }
      ]
     }
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "id",
     "type": "u32"
    },
    {
     "name": "args",
     "type": {
      "defined": {
       "name": "ContestArgs"
      }
     }
    }
   ]
  },
  {
   "name": "open_pool",
   "discriminator": [96, 215, 110, 61, 1, 246, 205, 228],
   "accounts": [
    {
     "name": "owner",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "mint"
    },
    {
     "name": "pool",
     "writable": true
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "index",
     "type": "u8"
    }
   ]
  },
  {
   "name": "open_stake",
   "discriminator": [136, 215, 163, 130, 234, 194, 229, 229],
   "accounts": [
    {
     "name": "owner",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "stake",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [115, 116, 97, 107, 101]
       },
       {
        "kind": "account",
        "path": "game"
       },
       {
        "kind": "arg",
        "path": "id"
       }
      ]
     }
    },
    {
     "name": "mint"
    },
    {
     "name": "rewards_mint"
    },
    {
     "name": "staked_vault",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [115, 116, 97, 107, 101, 100]
       },
       {
        "kind": "account",
        "path": "stake"
       }
      ]
     }
    },
    {
     "name": "rewards_vault",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [114, 101, 119, 97, 114, 100, 115]
       },
       {
        "kind": "account",
        "path": "stake"
       }
      ]
     }
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "id",
     "type": "u32"
    },
    {
     "name": "rewards_pool",
     "type": "u8"
    },
    {
     "name": "lock",
     "type": "i64"
    }
   ]
  },
  {
   "name": "pay",
   "discriminator": [119, 18, 216, 65, 192, 117, 122, 220],
   "accounts": [
    {
     "name": "player",
     "writable": true,
     "signer": true
    },
    {
     "name": "game"
    },
    {
     "name": "mint",
     "writable": true
    },
    {
     "name": "player_token",
     "writable": true
    },
    {
     "name": "treasury",
     "writable": true
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "amount",
     "type": "u64"
    },
    {
     "name": "shares",
     "type": {
      "vec": {
       "defined": {
        "name": "Share"
       }
      }
     }
    },
    {
     "name": "reference",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "pay_lottery",
   "discriminator": [6, 175, 47, 106, 152, 221, 34, 110],
   "accounts": [
    {
     "name": "game",
     "relations": [
      "lottery"
     ]
    },
    {
     "name": "lottery",
     "writable": true
    },
    {
     "name": "first_place",
     "writable": true
    },
    {
     "name": "pot",
     "writable": true
    },
    {
     "name": "to",
     "writable": true
    },
    {
     "name": "mint"
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    }
   ],
   "args": [
    {
     "name": "place",
     "type": "u8"
    }
   ]
  },
  {
   "name": "payout",
   "discriminator": [149, 140, 194, 236, 174, 189, 6, 239],
   "accounts": [
    {
     "name": "authority",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "pool",
     "writable": true
    },
    {
     "name": "to",
     "writable": true
    },
    {
     "name": "mint"
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "index",
     "type": "u8"
    },
    {
     "name": "amount",
     "type": "u64"
    },
    {
     "name": "reference",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "recheck_token",
   "discriminator": [196, 211, 144, 204, 205, 241, 179, 47],
   "accounts": [
    {
     "name": "game",
     "writable": true
    },
    {
     "name": "platform"
    },
    {
     "name": "venue_a"
    },
    {
     "name": "venue_b"
    }
   ],
   "args": []
  },
  {
   "name": "refund",
   "discriminator": [2, 96, 183, 251, 63, 208, 46, 46],
   "accounts": [
    {
     "name": "signer",
     "writable": true,
     "signer": true
    },
    {
     "name": "order",
     "writable": true
    },
    {
     "name": "player",
     "writable": true,
     "relations": [
      "order"
     ]
    },
    {
     "name": "game",
     "relations": [
      "order"
     ]
    },
    {
     "name": "escrow",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [101, 115, 99, 114, 111, 119]
       },
       {
        "kind": "account",
        "path": "order"
       }
      ]
     }
    },
    {
     "name": "mint"
    },
    {
     "name": "vault",
     "writable": true
    },
    {
     "name": "player_token",
     "writable": true
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "associated_token_program",
     "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": []
  },
  {
   "name": "roll",
   "discriminator": [143, 143, 93, 91, 13, 254, 64, 93],
   "accounts": [
    {
     "name": "authority",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "oracle_queue",
     "writable": true,
     "address": "Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    },
    {
     "name": "program_identity",
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [105, 100, 101, 110, 116, 105, 116, 121]
       }
      ]
     }
    },
    {
     "name": "vrf_program",
     "address": "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"
    },
    {
     "name": "slot_hashes",
     "address": "SysvarS1otHashes111111111111111111111111111"
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "reference",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "run_schedule",
   "discriminator": [179, 112, 243, 195, 32, 69, 224, 206],
   "accounts": [
    {
     "name": "game",
     "relations": [
      "schedule"
     ]
    },
    {
     "name": "schedule",
     "writable": true
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    }
   ],
   "args": []
  },
  {
   "name": "set",
   "discriminator": [198, 51, 53, 241, 116, 29, 126, 194],
   "accounts": [
    {
     "name": "authority",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "asset",
     "writable": true
    },
    {
     "name": "collection",
     "writable": true
    },
    {
     "name": "mpl_core_program",
     "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "attributes",
     "type": {
      "vec": {
       "defined": {
        "name": "Attribute"
       }
      }
     }
    },
    {
     "name": "reference",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "set_platform",
   "discriminator": [14, 33, 2, 169, 153, 155, 180, 248],
   "accounts": [
    {
     "name": "admin",
     "signer": true,
     "relations": [
      "platform"
     ]
    },
    {
     "name": "platform",
     "writable": true
    },
    {
     "name": "next_admin",
     "signer": true
    }
   ],
   "args": [
    {
     "name": "fees",
     "type": {
      "defined": {
       "name": "Fees"
      }
     }
    }
   ]
  },
  {
   "name": "set_suspended",
   "discriminator": [240, 182, 200, 60, 209, 54, 180, 240],
   "accounts": [
    {
     "name": "admin",
     "signer": true,
     "relations": [
      "platform"
     ]
    },
    {
     "name": "platform"
    },
    {
     "name": "game",
     "writable": true
    }
   ],
   "args": [
    {
     "name": "suspended",
     "type": "bool"
    }
   ]
  },
  {
   "name": "settle",
   "discriminator": [175, 42, 185, 87, 144, 131, 102, 212],
   "accounts": [
    {
     "name": "signer",
     "signer": true
    },
    {
     "name": "order",
     "writable": true
    },
    {
     "name": "player",
     "writable": true,
     "relations": [
      "order"
     ]
    },
    {
     "name": "game",
     "relations": [
      "order",
      "item"
     ]
    },
    {
     "name": "item"
    },
    {
     "name": "escrow",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [101, 115, 99, 114, 111, 119]
       },
       {
        "kind": "account",
        "path": "order"
       }
      ]
     }
    },
    {
     "name": "mint",
     "writable": true
    },
    {
     "name": "vault",
     "writable": true
    },
    {
     "name": "treasury",
     "writable": true
    },
    {
     "name": "collection",
     "writable": true
    },
    {
     "name": "asset",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [97, 115, 115, 101, 116]
       },
       {
        "kind": "account",
        "path": "order"
       },
       {
        "kind": "account",
        "path": "order.requested_slot",
        "account": "Order"
       }
      ]
     }
    },
    {
     "name": "mpl_core_program",
     "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fees",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [102, 101, 101, 115]
       },
       {
        "kind": "account",
        "path": "game"
       }
      ]
     }
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": []
  },
  {
   "name": "settle_prize",
   "discriminator": [88, 60, 162, 50, 219, 244, 96, 201],
   "accounts": [
    {
     "name": "order",
     "writable": true
    },
    {
     "name": "player",
     "writable": true,
     "relations": [
      "order"
     ]
    },
    {
     "name": "game",
     "relations": [
      "order"
     ]
    },
    {
     "name": "escrow",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [101, 115, 99, 114, 111, 119]
       },
       {
        "kind": "account",
        "path": "order"
       }
      ]
     }
    },
    {
     "name": "mint",
     "writable": true
    },
    {
     "name": "vault",
     "writable": true
    },
    {
     "name": "treasury",
     "writable": true
    },
    {
     "name": "prize_pool",
     "writable": true,
     "optional": true
    },
    {
     "name": "prize_to",
     "writable": true,
     "optional": true
    },
    {
     "name": "prize_mint",
     "optional": true
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fees",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [102, 101, 101, 115]
       },
       {
        "kind": "account",
        "path": "game"
       }
      ]
     }
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": []
  },
  {
   "name": "stake",
   "discriminator": [206, 176, 202, 18, 200, 209, 179, 108],
   "accounts": [
    {
     "name": "player",
     "writable": true,
     "signer": true
    },
    {
     "name": "game",
     "relations": [
      "stake"
     ]
    },
    {
     "name": "stake",
     "writable": true
    },
    {
     "name": "position",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [112, 111, 115, 105, 116, 105, 111, 110]
       },
       {
        "kind": "account",
        "path": "stake"
       },
       {
        "kind": "account",
        "path": "player"
       }
      ]
     }
    },
    {
     "name": "staked_vault",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [115, 116, 97, 107, 101, 100]
       },
       {
        "kind": "account",
        "path": "stake"
       }
      ]
     }
    },
    {
     "name": "rewards_vault",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [114, 101, 119, 97, 114, 100, 115]
       },
       {
        "kind": "account",
        "path": "stake"
       }
      ]
     }
    },
    {
     "name": "rewards_pool",
     "writable": true
    },
    {
     "name": "player_tokens",
     "writable": true
    },
    {
     "name": "player_rewards",
     "writable": true
    },
    {
     "name": "mint"
    },
    {
     "name": "rewards_mint"
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "amount",
     "type": "u64"
    }
   ]
  },
  {
   "name": "take_back",
   "discriminator": [99, 255, 183, 133, 153, 30, 12, 32],
   "accounts": [
    {
     "name": "signer",
     "writable": true,
     "signer": true
    },
    {
     "name": "game",
     "relations": [
      "hold"
     ]
    },
    {
     "name": "hold",
     "writable": true
    },
    {
     "name": "asset",
     "writable": true,
     "relations": [
      "hold"
     ]
    },
    {
     "name": "player",
     "writable": true,
     "relations": [
      "hold"
     ]
    },
    {
     "name": "collection"
    },
    {
     "name": "mpl_core_program",
     "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": []
  },
  {
   "name": "unmake",
   "discriminator": [56, 40, 134, 46, 168, 248, 120, 254],
   "accounts": [
    {
     "name": "authority",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "asset",
     "writable": true
    },
    {
     "name": "collection",
     "writable": true
    },
    {
     "name": "mpl_core_program",
     "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "reference",
     "type": {
      "array": [
       "u8",
       32
      ]
     }
    }
   ]
  },
  {
   "name": "unstake",
   "discriminator": [90, 95, 107, 42, 205, 124, 50, 225],
   "accounts": [
    {
     "name": "player",
     "writable": true,
     "signer": true
    },
    {
     "name": "game",
     "relations": [
      "stake"
     ]
    },
    {
     "name": "stake",
     "writable": true
    },
    {
     "name": "position",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [112, 111, 115, 105, 116, 105, 111, 110]
       },
       {
        "kind": "account",
        "path": "stake"
       },
       {
        "kind": "account",
        "path": "player"
       }
      ]
     }
    },
    {
     "name": "staked_vault",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [115, 116, 97, 107, 101, 100]
       },
       {
        "kind": "account",
        "path": "stake"
       }
      ]
     }
    },
    {
     "name": "rewards_vault",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [114, 101, 119, 97, 114, 100, 115]
       },
       {
        "kind": "account",
        "path": "stake"
       }
      ]
     }
    },
    {
     "name": "rewards_pool",
     "writable": true
    },
    {
     "name": "player_tokens",
     "writable": true
    },
    {
     "name": "player_rewards",
     "writable": true
    },
    {
     "name": "mint"
    },
    {
     "name": "rewards_mint"
    },
    {
     "name": "token_program",
     "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    },
    {
     "name": "token_2022_program",
     "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    },
    {
     "name": "fee",
     "accounts": [
      {
       "name": "platform"
      },
      {
       "name": "fees",
       "writable": true
      },
      {
       "name": "system_program",
       "address": "11111111111111111111111111111111"
      }
     ]
    }
   ],
   "args": [
    {
     "name": "amount",
     "type": "u64"
    },
    {
     "name": "forfeit",
     "type": "bool"
    }
   ]
  },
  {
   "name": "update_game",
   "discriminator": [159, 61, 132, 131, 3, 234, 209, 220],
   "accounts": [
    {
     "name": "owner",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game",
     "writable": true
    },
    {
     "name": "treasury"
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    },
    {
     "name": "new_owner",
     "signer": true,
     "optional": true
    }
   ],
   "args": [
    {
     "name": "update",
     "type": {
      "defined": {
       "name": "GameUpdate"
      }
     }
    }
   ]
  },
  {
   "name": "upsert_box",
   "discriminator": [19, 118, 81, 232, 2, 212, 86, 66],
   "accounts": [
    {
     "name": "owner",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "loot_box",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [98, 111, 120]
       },
       {
        "kind": "account",
        "path": "game"
       },
       {
        "kind": "arg",
        "path": "box_id"
       }
      ]
     }
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "box_id",
     "type": "u32"
    },
    {
     "name": "args",
     "type": {
      "defined": {
       "name": "BoxArgs"
      }
     }
    }
   ]
  },
  {
   "name": "upsert_item",
   "discriminator": [162, 170, 209, 51, 242, 20, 147, 84],
   "accounts": [
    {
     "name": "owner",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "item",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [105, 116, 101, 109]
       },
       {
        "kind": "account",
        "path": "game"
       },
       {
        "kind": "arg",
        "path": "item_id"
       }
      ]
     }
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "item_id",
     "type": "u32"
    },
    {
     "name": "args",
     "type": {
      "defined": {
       "name": "ItemArgs"
      }
     }
    }
   ]
  },
  {
   "name": "upsert_lottery",
   "discriminator": [80, 72, 253, 39, 70, 179, 125, 9],
   "accounts": [
    {
     "name": "owner",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "lottery",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [108, 111, 116, 116, 101, 114, 121]
       },
       {
        "kind": "account",
        "path": "game"
       },
       {
        "kind": "arg",
        "path": "id"
       }
      ]
     }
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "id",
     "type": "u32"
    },
    {
     "name": "args",
     "type": {
      "defined": {
       "name": "LotteryArgs"
      }
     }
    }
   ]
  },
  {
   "name": "upsert_recipe",
   "discriminator": [241, 40, 22, 234, 190, 226, 128, 91],
   "accounts": [
    {
     "name": "owner",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "recipe",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [114, 101, 99, 105, 112, 101]
       },
       {
        "kind": "account",
        "path": "game"
       },
       {
        "kind": "arg",
        "path": "id"
       }
      ]
     }
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "id",
     "type": "u32"
    },
    {
     "name": "args",
     "type": {
      "defined": {
       "name": "RecipeArgs"
      }
     }
    }
   ]
  },
  {
   "name": "upsert_schedule",
   "discriminator": [48, 45, 188, 74, 1, 74, 50, 122],
   "accounts": [
    {
     "name": "owner",
     "writable": true,
     "signer": true,
     "relations": [
      "game"
     ]
    },
    {
     "name": "game"
    },
    {
     "name": "schedule",
     "writable": true,
     "pda": {
      "seeds": [
       {
        "kind": "const",
        "value": [115, 99, 104, 101, 100, 117, 108, 101]
       },
       {
        "kind": "account",
        "path": "game"
       },
       {
        "kind": "arg",
        "path": "id"
       }
      ]
     }
    },
    {
     "name": "system_program",
     "address": "11111111111111111111111111111111"
    }
   ],
   "args": [
    {
     "name": "id",
     "type": "u32"
    },
    {
     "name": "args",
     "type": {
      "defined": {
       "name": "ScheduleArgs"
      }
     }
    }
   ]
  }
 ],
 "accounts": [
  {
   "name": "Contest",
   "discriminator": [13]
  },
  {
   "name": "Entry",
   "discriminator": [14]
  },
  {
   "name": "Game",
   "discriminator": [2]
  },
  {
   "name": "Hold",
   "discriminator": [12]
  },
  {
   "name": "Item",
   "discriminator": [3]
  },
  {
   "name": "LootBox",
   "discriminator": [4]
  },
  {
   "name": "Lottery",
   "discriminator": [8]
  },
  {
   "name": "Order",
   "discriminator": [5]
  },
  {
   "name": "Platform",
   "discriminator": [1]
  },
  {
   "name": "Recipe",
   "discriminator": [11]
  },
  {
   "name": "Schedule",
   "discriminator": [6]
  },
  {
   "name": "Stake",
   "discriminator": [9]
  }
 ],
 "events": [
  {
   "name": "AttributesSet",
   "discriminator": [152, 104, 86, 110, 13, 115, 157, 163]
  },
  {
   "name": "Awarded",
   "discriminator": [255, 24, 226, 21, 157, 74, 108, 62]
  },
  {
   "name": "Burned",
   "discriminator": [207, 37, 251, 154, 239, 229, 14, 67]
  },
  {
   "name": "CalledOff",
   "discriminator": [244, 32, 35, 93, 211, 114, 75, 209]
  },
  {
   "name": "Claimed",
   "discriminator": [217, 192, 123, 72, 108, 150, 248, 33]
  },
  {
   "name": "Crafted",
   "discriminator": [169, 195, 232, 146, 229, 14, 57, 149]
  },
  {
   "name": "Decided",
   "discriminator": [137, 200, 62, 254, 141, 53, 205, 172]
  },
  {
   "name": "Deposited",
   "discriminator": [111, 141, 26, 45, 161, 35, 100, 57]
  },
  {
   "name": "Entered",
   "discriminator": [247, 164, 21, 222, 219, 178, 237, 160]
  },
  {
   "name": "FeeChanged",
   "discriminator": [103, 252, 132, 250, 1, 49, 116, 145]
  },
  {
   "name": "GameSuspended",
   "discriminator": [84, 155, 95, 35, 245, 14, 207, 199]
  },
  {
   "name": "Held",
   "discriminator": [46, 8, 96, 23, 131, 53, 182, 98]
  },
  {
   "name": "Issued",
   "discriminator": [13, 203, 75, 37, 35, 96, 248, 250]
  },
  {
   "name": "LotteryDrawn",
   "discriminator": [38, 250, 156, 196, 171, 79, 154, 208]
  },
  {
   "name": "LotteryPaid",
   "discriminator": [187, 208, 228, 188, 26, 6, 174, 127]
  },
  {
   "name": "Made",
   "discriminator": [240, 91, 7, 65, 219, 115, 50, 224]
  },
  {
   "name": "OrderFailed",
   "discriminator": [60, 179, 157, 0, 164, 131, 38, 236]
  },
  {
   "name": "OrderRefunded",
   "discriminator": [120, 155, 10, 169, 7, 98, 202, 187]
  },
  {
   "name": "OrderRolled",
   "discriminator": [91, 246, 84, 1, 21, 64, 240, 229]
  },
  {
   "name": "OrderSettled",
   "discriminator": [32, 21, 123, 33, 68, 59, 136, 131]
  },
  {
   "name": "Paid",
   "discriminator": [240, 193, 17, 238, 238, 210, 129, 235]
  },
  {
   "name": "PaidOut",
   "discriminator": [6, 137, 209, 225, 252, 53, 249, 252]
  },
  {
   "name": "Returned",
   "discriminator": [10, 240, 87, 178, 40, 21, 158, 220]
  },
  {
   "name": "Rolled",
   "discriminator": [243, 213, 137, 215, 92, 162, 11, 192]
  },
  {
   "name": "ScheduleRan",
   "discriminator": [145, 158, 228, 183, 251, 229, 1, 242]
  },
  {
   "name": "Staked",
   "discriminator": [11, 146, 45, 205, 230, 58, 213, 240]
  },
  {
   "name": "TicketsBought",
   "discriminator": [204, 103, 221, 60, 70, 142, 88, 233]
  },
  {
   "name": "TokenAttached",
   "discriminator": [28, 49, 174, 154, 20, 29, 239, 201]
  },
  {
   "name": "TokenCleared",
   "discriminator": [127, 39, 52, 188, 238, 72, 238, 44]
  },
  {
   "name": "Unmade",
   "discriminator": [123, 51, 157, 99, 253, 186, 107, 99]
  },
  {
   "name": "Unstaked",
   "discriminator": [27, 179, 156, 215, 47, 71, 195, 7]
  }
 ],
 "errors": [
  {
   "code": 6000,
   "name": "NotOwner",
   "msg": "Signer is not the game's owner"
  },
  {
   "code": 6001,
   "name": "NotTheGames",
   "msg": "Signer is not the game's owner or its authority"
  },
  {
   "code": 6002,
   "name": "NotAuthority",
   "msg": "Signer is not the game's authority"
  },
  {
   "code": 6003,
   "name": "NotPlatform",
   "msg": "Signer is not the platform admin or the program's upgrade authority"
  },
  {
   "code": 6004,
   "name": "BadCollection",
   "msg": "Collection is not a Core collection this signer controls"
  },
  {
   "code": 6005,
   "name": "CollectionCanSeize",
   "msg": "This collection can freeze, move or burn its assets whoever holds them"
  },
  {
   "code": 6006,
   "name": "FeeAboveCap",
   "msg": "Fee is above the cap"
  },
  {
   "code": 6007,
   "name": "StringTooLong",
   "msg": "Name or URI too long"
  },
  {
   "code": 6008,
   "name": "BadEntries",
   "msg": "Box needs 1 to 8 entries with non-zero weights and non-zero prizes (none that burns in wrapped SOL)"
  },
  {
   "code": 6009,
   "name": "BadShares",
   "msg": "A split takes at most 4 shares that add up to 100% or less (exactly 100% for a box in another mint; none that burns in wrapped SOL)"
  },
  {
   "code": 6010,
   "name": "SupplyBelowIssued",
   "msg": "Max supply is below the units already out (issued, less voided)"
  },
  {
   "code": 6011,
   "name": "PoolNotEmpty",
   "msg": "A pool that still holds tokens can't be closed"
  },
  {
   "code": 6012,
   "name": "KindLocked",
   "msg": "An item's kind, name, life, soulbound and burnable flags can't change once one is issued"
  },
  {
   "code": 6013,
   "name": "Paused",
   "msg": "Game is paused by its owner"
  },
  {
   "code": 6014,
   "name": "Suspended",
   "msg": "Game is suspended by the platform"
  },
  {
   "code": 6015,
   "name": "ZeroAmount",
   "msg": "Amount must be above zero"
  },
  {
   "code": 6016,
   "name": "NotForSale",
   "msg": "Box, item or recipe is not on offer"
  },
  {
   "code": 6017,
   "name": "SoldOut",
   "msg": "Item is sold out"
  },
  {
   "code": 6018,
   "name": "PriceAboveMax",
   "msg": "The price is above the most the buyer agreed to pay"
  },
  {
   "code": 6019,
   "name": "WrongPool",
   "msg": "A share names an account that was not passed, or the wrong account was"
  },
  {
   "code": 6020,
   "name": "NotTheHolders",
   "msg": "A share for whoever holds a collectible must go to a token account of that mint that the holder owns"
  },
  {
   "code": 6021,
   "name": "WrongMint",
   "msg": "This is not the mint the price is in"
  },
  {
   "code": 6022,
   "name": "BadOrderState",
   "msg": "Order is not in the right state"
  },
  {
   "code": 6023,
   "name": "NotStale",
   "msg": "Order is not stale yet"
  },
  {
   "code": 6024,
   "name": "ItemMismatch",
   "msg": "Item or pool accounts don't match the box or the order"
  },
  {
   "code": 6025,
   "name": "WrongSettle",
   "msg": "This order's outcome is settled by the other settle instruction"
  },
  {
   "code": 6026,
   "name": "NotThePlayers",
   "msg": "The prize must go to a token account the order's player owns"
  },
  {
   "code": 6027,
   "name": "NotCollectible",
   "msg": "Only a collectible item can be made as an asset"
  },
  {
   "code": 6028,
   "name": "BadSchedule",
   "msg": "A schedule needs a period above zero, a share of 100% or less, and a move between two different pools"
  },
  {
   "code": 6029,
   "name": "NotDue",
   "msg": "This is not due yet"
  },
  {
   "code": 6030,
   "name": "ScheduleOver",
   "msg": "This schedule is switched off or has done its last run"
  },
  {
   "code": 6031,
   "name": "BadLottery",
   "msg": "A lottery needs a price and a period above zero, a period of at most 1,000 years and a first draw between 1970 and 1,000 years later, a cut of 100% or less, and at most 8 places that each take something and together 100% or less"
  },
  {
   "code": 6032,
   "name": "RoundRunning",
   "msg": "A lottery can't be changed while tickets of its round are sold"
  },
  {
   "code": 6033,
   "name": "SalesClosed",
   "msg": "Ticket sales are closed for this round"
  },
  {
   "code": 6034,
   "name": "StillLocked",
   "msg": "This stake can't be taken out yet: its lock has not run"
  },
  {
   "code": 6035,
   "name": "MoreThanStaked",
   "msg": "That is more than this position holds"
  },
  {
   "code": 6036,
   "name": "BadRecipe",
   "msg": "A recipe has up to 8 lines a side, takes up to 8 collectibles, no line of it is zero, and its needs and keeps name collectibles it has"
  },
  {
   "code": 6037,
   "name": "OnceAtATime",
   "msg": "A recipe that takes or makes a collectible is crafted once at a time"
  },
  {
   "code": 6038,
   "name": "NeedNotMet",
   "msg": "A collectible handed in does not have the number this recipe asks for"
  },
  {
   "code": 6039,
   "name": "RecipeChanged",
   "msg": "This recipe was edited since the player saw it"
  },
  {
   "code": 6040,
   "name": "NotReady",
   "msg": "This collectible is not ready yet: it is too new, or it was used too recently"
  },
  {
   "code": 6041,
   "name": "Expired",
   "msg": "This collectible has expired"
  },
  {
   "code": 6042,
   "name": "UsedUp",
   "msg": "This collectible has no uses left"
  },
  {
   "code": 6043,
   "name": "Held",
   "msg": "The game is holding this collectible for a player"
  },
  {
   "code": 6044,
   "name": "TermsChanged",
   "msg": "These are not the terms this contest has"
  },
  {
   "code": 6045,
   "name": "ResultOverdue",
   "msg": "This contest's result was due: it can only be called off"
  },
  {
   "code": 6046,
   "name": "StillHeld",
   "msg": "This collectible is held until its time is up"
  },
  {
   "code": 6047,
   "name": "HoldOver",
   "msg": "The hold on this collectible is over: it can only go back to its player"
  },
  {
   "code": 6048,
   "name": "BadContest",
   "msg": "A contest needs 2 or more sides, entries that close no later than its result is due, and a side that exists"
  },
  {
   "code": 6049,
   "name": "ContestNotOpen",
   "msg": "This contest is not open"
  },
  {
   "code": 6050,
   "name": "ContestOpen",
   "msg": "This contest has no result yet"
  },
  {
   "code": 6051,
   "name": "NoWinner",
   "msg": "Nobody backed that side: call the contest off instead"
  },
  {
   "code": 6052,
   "name": "EntriesLeft",
   "msg": "This contest still has entries to claim"
  },
  {
   "code": 6053,
   "name": "NotATokenAccount",
   "msg": "Not a token account"
  },
  {
   "code": 6054,
   "name": "Overflow",
   "msg": "Arithmetic overflow"
  },
  {
   "code": 6055,
   "name": "NoToken",
   "msg": "Game has no official token"
  },
  {
   "code": 6056,
   "name": "VenueAccounts",
   "msg": "These are not the venue's own accounts for this mint"
  },
  {
   "code": 6057,
   "name": "VenueLayout",
   "msg": "Venue account layout is not one this program knows"
  },
  {
   "code": 6058,
   "name": "LauncherMustSign",
   "msg": "The wallet that launched the token must sign"
  },
  {
   "code": 6059,
   "name": "FeeClaimerNotPartner",
   "msg": "Meteora config: the fee claimer is not the games.fun partner"
  },
  {
   "code": 6060,
   "name": "CreatorFeeTooHigh",
   "msg": "Meteora config: the creator's trading fee share is above 95%"
  },
  {
   "code": 6061,
   "name": "PartnerLockTooLow",
   "msg": "Meteora config: the partner's permanently locked liquidity is below 5%"
  },
  {
   "code": 6062,
   "name": "CreatorMigrationFeeTooHigh",
   "msg": "Meteora config: the creator takes more than 95% of the migration fee"
  },
  {
   "code": 6063,
   "name": "CompoundingFees",
   "msg": "Meteora config: the migrated pool compounds its fees instead of paying them out"
  },
  {
   "code": 6064,
   "name": "NoBondingCurve",
   "msg": "pump.fun: no bonding curve for this mint"
  },
  {
   "code": 6065,
   "name": "NoFeeSharing",
   "msg": "pump.fun: no fee-sharing config for this mint"
  },
  {
   "code": 6066,
   "name": "CurveNotSharing",
   "msg": "pump.fun: the bonding curve does not pay the fee-sharing config"
  },
  {
   "code": 6067,
   "name": "SharingNotActive",
   "msg": "pump.fun: fee sharing is not active"
  },
  {
   "code": 6068,
   "name": "SharingAdminNotRevoked",
   "msg": "pump.fun: the fee-sharing admin is not revoked"
  },
  {
   "code": 6069,
   "name": "ShareholdersMismatch",
   "msg": "pump.fun: shareholders are not the launcher and the partner with at least 5%, together 100%"
  },
  {
   "code": 6070,
   "name": "CreatorFeeDiverted",
   "msg": "pump.fun: this coin's creator fee goes to traders or holders, not to the fee-sharing config"
  },
  {
   "code": 6071,
   "name": "BadPrice",
   "msg": "A falling price needs a step and a period above zero, and a start that is not before 1970"
  },
  {
   "code": 6072,
   "name": "PlacePaid",
   "msg": "This place has no winner this round, or was paid already"
  },
  {
   "code": 6073,
   "name": "NotAMint",
   "msg": "Not a mint of the SPL Token program or of Token-2022"
  },
  {
   "code": 6074,
   "name": "MemoNeeded",
   "msg": "A destination requires a memo: pass the Memo program with the hook's accounts"
  },
  {
   "code": 6075,
   "name": "SameAccount",
   "msg": "The game can't pay into the account it pays from"
  },
  {
   "code": 6076,
   "name": "SameSlot",
   "msg": "An order closes in a later slot than the one it was opened in"
  },
  {
   "code": 6077,
   "name": "ToTheGame",
   "msg": "The game can't be given a collectible: nothing could ever move it again"
  }
 ],
 "types": [
  {
   "name": "Action",
   "type": {
    "kind": "enum",
    "variants": [
     {
      "name": "Issue",
      "fields": [
       {
        "name": "mint",
        "type": "pubkey"
       },
       {
        "name": "pool",
        "type": "u8"
       },
       {
        "name": "amount",
        "type": "u64"
       },
       {
        "name": "halve_every",
        "type": "u32"
       }
      ]
     },
     {
      "name": "Burn",
      "fields": [
       {
        "name": "pool",
        "type": "u8"
       },
       {
        "name": "bps",
        "type": "u16"
       }
      ]
     },
     {
      "name": "Move",
      "fields": [
       {
        "name": "from",
        "type": "u8"
       },
       {
        "name": "to",
        "type": "u8"
       },
       {
        "name": "bps",
        "type": "u16"
       }
      ]
     }
    ]
   }
  },
  {
   "name": "Attribute",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "key",
      "type": "string"
     },
     {
      "name": "value",
      "type": "string"
     }
    ]
   }
  },
  {
   "name": "AttributesSet",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "authority",
      "type": "pubkey"
     },
     {
      "name": "asset",
      "type": "pubkey"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "Awarded",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "authority",
      "type": "pubkey"
     },
     {
      "name": "asset",
      "type": "pubkey"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "to",
      "type": "pubkey"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "BoxArgs",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "price",
      "type": "u64"
     },
     {
      "name": "currency",
      "type": {
       "option": "pubkey"
      }
     },
     {
      "name": "rise",
      "type": {
       "option": {
        "defined": {
         "name": "Rise"
        }
       }
      }
     },
     {
      "name": "fall",
      "type": {
       "option": {
        "defined": {
         "name": "Fall"
        }
       }
      }
     },
     {
      "name": "stock_odds",
      "type": "bool"
     },
     {
      "name": "active",
      "type": "bool"
     },
     {
      "name": "shares",
      "type": {
       "vec": {
        "defined": {
         "name": "Share"
        }
       }
      }
     },
     {
      "name": "entries",
      "type": {
       "vec": {
        "defined": {
         "name": "DropEntry"
        }
       }
      }
     }
    ]
   }
  },
  {
   "name": "Burned",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "authority",
      "type": "pubkey"
     },
     {
      "name": "pool",
      "type": "u8"
     },
     {
      "name": "mint",
      "type": "pubkey"
     },
     {
      "name": "amount",
      "type": "u64"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "CalledOff",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     }
    ]
   }
  },
  {
   "name": "Claimed",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "side",
      "type": "u8"
     },
     {
      "name": "amount",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "Contest",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "bump",
      "type": "u8"
     },
     {
      "name": "opener",
      "type": "pubkey"
     },
     {
      "name": "mint",
      "type": "pubkey"
     },
     {
      "name": "closes_at",
      "type": "i64"
     },
     {
      "name": "result_by",
      "type": "i64"
     },
     {
      "name": "terms",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     },
     {
      "name": "verdict",
      "type": {
       "defined": {
        "name": "Verdict"
       }
      }
     },
     {
      "name": "winner",
      "type": "u8"
     },
     {
      "name": "entries",
      "type": "u32"
     },
     {
      "name": "prize",
      "type": "u64"
     },
     {
      "name": "unclaimed",
      "type": "u64"
     },
     {
      "name": "shares",
      "type": {
       "vec": {
        "defined": {
         "name": "Share"
        }
       }
      }
     },
     {
      "name": "sides",
      "type": {
       "vec": "u64"
      }
     }
    ]
   }
  },
  {
   "name": "ContestArgs",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "sides",
      "type": "u8"
     },
     {
      "name": "closes_at",
      "type": "i64"
     },
     {
      "name": "result_by",
      "type": "i64"
     },
     {
      "name": "shares",
      "type": {
       "vec": {
        "defined": {
         "name": "Share"
        }
       }
      }
     }
    ]
   }
  },
  {
   "name": "Crafted",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "version",
      "type": "u32"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "times",
      "type": "u64"
     },
     {
      "name": "burned",
      "type": {
       "vec": "pubkey"
      }
     },
     {
      "name": "used",
      "type": {
       "vec": "pubkey"
      }
     },
     {
      "name": "made",
      "type": {
       "vec": "pubkey"
      }
     }
    ]
   }
  },
  {
   "name": "Decided",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "side",
      "type": "u8"
     },
     {
      "name": "pot",
      "type": "u64"
     },
     {
      "name": "prize",
      "type": "u64"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "Deposited",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "pool",
      "type": "u8"
     },
     {
      "name": "depositor",
      "type": "pubkey"
     },
     {
      "name": "amount",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "DropEntry",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "outcome",
      "type": {
       "defined": {
        "name": "Outcome"
       }
      }
     },
     {
      "name": "weight",
      "type": "u32"
     }
    ]
   }
  },
  {
   "name": "Entered",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "side",
      "type": "u8"
     },
     {
      "name": "amount",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "Entry",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "contest",
      "type": "pubkey"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "side",
      "type": "u8"
     },
     {
      "name": "bump",
      "type": "u8"
     },
     {
      "name": "amount",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "Fall",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "step",
      "type": "u64"
     },
     {
      "name": "every",
      "type": "u32"
     },
     {
      "name": "floor",
      "type": "u64"
     },
     {
      "name": "since",
      "type": "i64"
     }
    ]
   }
  },
  {
   "name": "FeeChanged",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "fees",
      "type": {
       "defined": {
        "name": "Fees"
       }
      }
     },
     {
      "name": "pending",
      "type": {
       "defined": {
        "name": "Fees"
       }
      }
     },
     {
      "name": "pending_at",
      "type": "i64"
     }
    ]
   }
  },
  {
   "name": "Fees",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "player",
      "type": "u64"
     },
     {
      "name": "project",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "Game",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "owner",
      "type": "pubkey"
     },
     {
      "name": "authority",
      "type": "pubkey"
     },
     {
      "name": "collection",
      "type": "pubkey"
     },
     {
      "name": "mint",
      "type": "pubkey"
     },
     {
      "name": "treasury",
      "type": "pubkey"
     },
     {
      "name": "bump",
      "type": "u8"
     },
     {
      "name": "fees_bump",
      "type": "u8"
     },
     {
      "name": "paused",
      "type": "bool"
     },
     {
      "name": "suspended",
      "type": "bool"
     },
     {
      "name": "official",
      "type": {
       "option": {
        "defined": {
         "name": "OfficialToken"
        }
       }
      }
     }
    ]
   }
  },
  {
   "name": "GameSuspended",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "suspended",
      "type": "bool"
     }
    ]
   }
  },
  {
   "name": "GameUpdate",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "authority",
      "type": {
       "option": "pubkey"
      }
     },
     {
      "name": "paused",
      "type": {
       "option": "bool"
      }
     }
    ]
   }
  },
  {
   "name": "Held",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "asset",
      "type": "pubkey"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "free_at",
      "type": "i64"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "Hold",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "asset",
      "type": "pubkey"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "free_at",
      "type": "i64"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     },
     {
      "name": "bump",
      "type": "u8"
     }
    ]
   }
  },
  {
   "name": "Input",
   "type": {
    "kind": "enum",
    "variants": [
     {
      "name": "Burn",
      "fields": [
       {
        "name": "item",
        "type": "u32"
       },
       {
        "name": "count",
        "type": "u8"
       }
      ]
     },
     {
      "name": "Use",
      "fields": [
       {
        "name": "item",
        "type": "u32"
       }
      ]
     },
     {
      "name": "Renew",
      "fields": [
       {
        "name": "item",
        "type": "u32"
       }
      ]
     },
     {
      "name": "Pay",
      "fields": [
       {
        "name": "mint",
        "type": "pubkey"
       },
       {
        "name": "amount",
        "type": "u64"
       },
       {
        "name": "to",
        "type": {
         "defined": {
          "name": "To"
         }
        }
       }
      ]
     }
    ]
   }
  },
  {
   "name": "Issued",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "authority",
      "type": "pubkey"
     },
     {
      "name": "mint",
      "type": "pubkey"
     },
     {
      "name": "to",
      "type": "pubkey"
     },
     {
      "name": "amount",
      "type": "u64"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "Item",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "item_id",
      "type": "u32"
     },
     {
      "name": "kind",
      "type": {
       "defined": {
        "name": "ItemKind"
       }
      }
     },
     {
      "name": "rarity",
      "type": "u8"
     },
     {
      "name": "soulbound",
      "type": "bool"
     },
     {
      "name": "burnable",
      "type": "bool"
     },
     {
      "name": "max_supply",
      "type": "u32"
     },
     {
      "name": "issued",
      "type": "u32"
     },
     {
      "name": "voided",
      "type": "u32"
     },
     {
      "name": "price",
      "type": "u64"
     },
     {
      "name": "active",
      "type": "bool"
     },
     {
      "name": "bump",
      "type": "u8"
     },
     {
      "name": "rise",
      "type": {
       "option": {
        "defined": {
         "name": "Rise"
        }
       }
      }
     },
     {
      "name": "fall",
      "type": {
       "option": {
        "defined": {
         "name": "Fall"
        }
       }
      }
     },
     {
      "name": "life",
      "type": {
       "option": {
        "defined": {
         "name": "Life"
        }
       }
      }
     },
     {
      "name": "shares",
      "type": {
       "vec": {
        "defined": {
         "name": "Share"
        }
       }
      }
     },
     {
      "name": "name",
      "type": "string"
     },
     {
      "name": "uri",
      "type": "string"
     }
    ]
   }
  },
  {
   "name": "ItemArgs",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "kind",
      "type": {
       "defined": {
        "name": "ItemKind"
       }
      }
     },
     {
      "name": "rarity",
      "type": "u8"
     },
     {
      "name": "soulbound",
      "type": "bool"
     },
     {
      "name": "burnable",
      "type": "bool"
     },
     {
      "name": "name",
      "type": "string"
     },
     {
      "name": "uri",
      "type": "string"
     },
     {
      "name": "max_supply",
      "type": "u32"
     },
     {
      "name": "price",
      "type": "u64"
     },
     {
      "name": "rise",
      "type": {
       "option": {
        "defined": {
         "name": "Rise"
        }
       }
      }
     },
     {
      "name": "fall",
      "type": {
       "option": {
        "defined": {
         "name": "Fall"
        }
       }
      }
     },
     {
      "name": "life",
      "type": {
       "option": {
        "defined": {
         "name": "Life"
        }
       }
      }
     },
     {
      "name": "active",
      "type": "bool"
     },
     {
      "name": "shares",
      "type": {
       "vec": {
        "defined": {
         "name": "Share"
        }
       }
      }
     }
    ]
   }
  },
  {
   "name": "ItemKind",
   "type": {
    "kind": "enum",
    "variants": [
     {
      "name": "Normal"
     },
     {
      "name": "Collectible"
     }
    ]
   }
  },
  {
   "name": "Keep",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "key",
      "type": "string"
     },
     {
      "name": "from",
      "type": "u8"
     },
     {
      "name": "to",
      "type": "u8"
     }
    ]
   }
  },
  {
   "name": "Life",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "ready_after",
      "type": "u32"
     },
     {
      "name": "lasts",
      "type": "u32"
     },
     {
      "name": "uses",
      "type": "u32"
     },
     {
      "name": "cooldown",
      "type": "u32"
     }
    ]
   }
  },
  {
   "name": "LootBox",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "box_id",
      "type": "u32"
     },
     {
      "name": "price",
      "type": "u64"
     },
     {
      "name": "currency",
      "type": {
       "option": "pubkey"
      }
     },
     {
      "name": "rise",
      "type": {
       "option": {
        "defined": {
         "name": "Rise"
        }
       }
      }
     },
     {
      "name": "fall",
      "type": {
       "option": {
        "defined": {
         "name": "Fall"
        }
       }
      }
     },
     {
      "name": "stock_odds",
      "type": "bool"
     },
     {
      "name": "active",
      "type": "bool"
     },
     {
      "name": "opened",
      "type": "u64"
     },
     {
      "name": "version",
      "type": "u32"
     },
     {
      "name": "bump",
      "type": "u8"
     },
     {
      "name": "shares",
      "type": {
       "vec": {
        "defined": {
         "name": "Share"
        }
       }
      }
     },
     {
      "name": "entries",
      "type": {
       "vec": {
        "defined": {
         "name": "DropEntry"
        }
       }
      }
     }
    ]
   }
  },
  {
   "name": "Lottery",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "bump",
      "type": "u8"
     },
     {
      "name": "price",
      "type": "u64"
     },
     {
      "name": "pot",
      "type": "u8"
     },
     {
      "name": "cut_bps",
      "type": "u16"
     },
     {
      "name": "places",
      "type": {
       "array": [
        "u16",
        8
       ]
      }
     },
     {
      "name": "ticket_mint",
      "type": "pubkey"
     },
     {
      "name": "every",
      "type": "i64"
     },
     {
      "name": "draws_at",
      "type": "i64"
     },
     {
      "name": "round",
      "type": "u32"
     },
     {
      "name": "status",
      "type": {
       "defined": {
        "name": "Round"
       }
      }
     },
     {
      "name": "sold",
      "type": "u64"
     },
     {
      "name": "asked_slot",
      "type": "u64"
     },
     {
      "name": "winner",
      "type": "pubkey"
     },
     {
      "name": "first_ticket",
      "type": "u64"
     },
     {
      "name": "paid",
      "type": "u8"
     },
     {
      "name": "pot_at_payout",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "LotteryArgs",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "price",
      "type": "u64"
     },
     {
      "name": "pot",
      "type": "u8"
     },
     {
      "name": "cut_bps",
      "type": "u16"
     },
     {
      "name": "places",
      "type": {
       "vec": "u16"
      }
     },
     {
      "name": "ticket_mint",
      "type": "pubkey"
     },
     {
      "name": "every",
      "type": "i64"
     },
     {
      "name": "draws_at",
      "type": "i64"
     }
    ]
   }
  },
  {
   "name": "LotteryDrawn",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "round",
      "type": "u32"
     },
     {
      "name": "winning_ticket",
      "type": "u64"
     },
     {
      "name": "winners",
      "type": {
       "vec": "pubkey"
      }
     },
     {
      "name": "randomness",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "LotteryPaid",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "round",
      "type": "u32"
     },
     {
      "name": "place",
      "type": "u8"
     },
     {
      "name": "winner",
      "type": "pubkey"
     },
     {
      "name": "amount",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "Made",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "authority",
      "type": "pubkey"
     },
     {
      "name": "item_id",
      "type": "u32"
     },
     {
      "name": "serial",
      "type": "u32"
     },
     {
      "name": "asset",
      "type": "pubkey"
     },
     {
      "name": "owner",
      "type": "pubkey"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "Need",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "place",
      "type": "u8"
     },
     {
      "name": "key",
      "type": "string"
     },
     {
      "name": "at_least",
      "type": "u32"
     }
    ]
   }
  },
  {
   "name": "OfficialToken",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "mint",
      "type": "pubkey"
     },
     {
      "name": "venue",
      "type": {
       "defined": {
        "name": "Venue"
       }
      }
     }
    ]
   }
  },
  {
   "name": "Order",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "nonce",
      "type": "u64"
     },
     {
      "name": "mint",
      "type": "pubkey"
     },
     {
      "name": "loot_box",
      "type": "pubkey"
     },
     {
      "name": "box_version",
      "type": "u32"
     },
     {
      "name": "status",
      "type": {
       "defined": {
        "name": "OrderStatus"
       }
      }
     },
     {
      "name": "outcome",
      "type": {
       "defined": {
        "name": "Outcome"
       }
      }
     },
     {
      "name": "serial",
      "type": "u32"
     },
     {
      "name": "paid",
      "type": "u64"
     },
     {
      "name": "fee",
      "type": "u64"
     },
     {
      "name": "shares",
      "type": {
       "vec": {
        "defined": {
         "name": "Share"
        }
       }
      }
     },
     {
      "name": "requested_slot",
      "type": "u64"
     },
     {
      "name": "bump",
      "type": "u8"
     }
    ]
   }
  },
  {
   "name": "OrderFailed",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "order",
      "type": "pubkey"
     },
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "player",
      "type": "pubkey"
     }
    ]
   }
  },
  {
   "name": "OrderRefunded",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "order",
      "type": "pubkey"
     },
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "amount",
      "type": "u64"
     },
     {
      "name": "serial_released",
      "type": "bool"
     }
    ]
   }
  },
  {
   "name": "OrderRolled",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "order",
      "type": "pubkey"
     },
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "loot_box",
      "type": "pubkey"
     },
     {
      "name": "outcome",
      "type": {
       "defined": {
        "name": "Outcome"
       }
      }
     },
     {
      "name": "serial",
      "type": "u32"
     },
     {
      "name": "randomness",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "OrderSettled",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "order",
      "type": "pubkey"
     },
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "outcome",
      "type": {
       "defined": {
        "name": "Outcome"
       }
      }
     },
     {
      "name": "serial",
      "type": "u32"
     },
     {
      "name": "asset",
      "type": "pubkey"
     },
     {
      "name": "amount",
      "type": "u64"
     },
     {
      "name": "burned",
      "type": "u64"
     },
     {
      "name": "shares",
      "type": {
       "vec": {
        "defined": {
         "name": "Share"
        }
       }
      }
     },
     {
      "name": "to_treasury",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "OrderStatus",
   "type": {
    "kind": "enum",
    "variants": [
     {
      "name": "Pending"
     },
     {
      "name": "Rolled"
     },
     {
      "name": "Failed"
     }
    ]
   }
  },
  {
   "name": "Origin",
   "type": {
    "kind": "enum",
    "variants": [
     {
      "name": "Issue"
     },
     {
      "name": "Pool",
      "fields": [
       "u8"
      ]
     }
    ]
   }
  },
  {
   "name": "Outcome",
   "type": {
    "kind": "enum",
    "variants": [
     {
      "name": "Item",
      "fields": [
       "u32"
      ]
     },
     {
      "name": "Pay",
      "fields": [
       {
        "name": "pool",
        "type": "u8"
       },
       {
        "name": "amount",
        "type": "u64"
       }
      ]
     },
     {
      "name": "Share",
      "fields": [
       {
        "name": "pool",
        "type": "u8"
       },
       {
        "name": "bps",
        "type": "u16"
       }
      ]
     },
     {
      "name": "Burn"
     },
     {
      "name": "Nothing"
     }
    ]
   }
  },
  {
   "name": "Output",
   "type": {
    "kind": "enum",
    "variants": [
     {
      "name": "Item",
      "fields": [
       "u32"
      ]
     },
     {
      "name": "Tokens",
      "fields": [
       {
        "name": "mint",
        "type": "pubkey"
       },
       {
        "name": "amount",
        "type": "u64"
       },
       {
        "name": "from",
        "type": {
         "defined": {
          "name": "Origin"
         }
        }
       }
      ]
     },
     {
      "name": "Share",
      "fields": [
       {
        "name": "mint",
        "type": "pubkey"
       },
       {
        "name": "pool",
        "type": "u8"
       },
       {
        "name": "bps",
        "type": "u16"
       }
      ]
     }
    ]
   }
  },
  {
   "name": "Paid",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "mint",
      "type": "pubkey"
     },
     {
      "name": "amount",
      "type": "u64"
     },
     {
      "name": "shares",
      "type": {
       "vec": {
        "defined": {
         "name": "Share"
        }
       }
      }
     },
     {
      "name": "to_treasury",
      "type": "u64"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "PaidOut",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "authority",
      "type": "pubkey"
     },
     {
      "name": "pool",
      "type": "u8"
     },
     {
      "name": "to",
      "type": "pubkey"
     },
     {
      "name": "amount",
      "type": "u64"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "Platform",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "admin",
      "type": "pubkey"
     },
     {
      "name": "partner",
      "type": "pubkey"
     },
     {
      "name": "fees",
      "type": {
       "defined": {
        "name": "Fees"
       }
      }
     },
     {
      "name": "pending",
      "type": {
       "defined": {
        "name": "Fees"
       }
      }
     },
     {
      "name": "pending_at",
      "type": "i64"
     },
     {
      "name": "bump",
      "type": "u8"
     }
    ]
   }
  },
  {
   "name": "Recipe",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "bump",
      "type": "u8"
     },
     {
      "name": "active",
      "type": "bool"
     },
     {
      "name": "version",
      "type": "u32"
     },
     {
      "name": "inputs",
      "type": {
       "vec": {
        "defined": {
         "name": "Input"
        }
       }
      }
     },
     {
      "name": "outputs",
      "type": {
       "vec": {
        "defined": {
         "name": "Output"
        }
       }
      }
     },
     {
      "name": "needs",
      "type": {
       "vec": {
        "defined": {
         "name": "Need"
        }
       }
      }
     },
     {
      "name": "keeps",
      "type": {
       "vec": {
        "defined": {
         "name": "Keep"
        }
       }
      }
     }
    ]
   }
  },
  {
   "name": "RecipeArgs",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "active",
      "type": "bool"
     },
     {
      "name": "inputs",
      "type": {
       "vec": {
        "defined": {
         "name": "Input"
        }
       }
      }
     },
     {
      "name": "outputs",
      "type": {
       "vec": {
        "defined": {
         "name": "Output"
        }
       }
      }
     },
     {
      "name": "needs",
      "type": {
       "vec": {
        "defined": {
         "name": "Need"
        }
       }
      }
     },
     {
      "name": "keeps",
      "type": {
       "vec": {
        "defined": {
         "name": "Keep"
        }
       }
      }
     }
    ]
   }
  },
  {
   "name": "Returned",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "asset",
      "type": "pubkey"
     },
     {
      "name": "player",
      "type": "pubkey"
     }
    ]
   }
  },
  {
   "name": "Rise",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "step",
      "type": "u64"
     },
     {
      "name": "growth_bps",
      "type": "u16"
     }
    ]
   }
  },
  {
   "name": "Rolled",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     },
     {
      "name": "randomness",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "Round",
   "type": {
    "kind": "enum",
    "variants": [
     {
      "name": "Open"
     },
     {
      "name": "Drawing"
     },
     {
      "name": "Drawn"
     }
    ]
   }
  },
  {
   "name": "Schedule",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "bump",
      "type": "u8"
     },
     {
      "name": "active",
      "type": "bool"
     },
     {
      "name": "action",
      "type": {
       "defined": {
        "name": "Action"
       }
      }
     },
     {
      "name": "every",
      "type": "i64"
     },
     {
      "name": "next_at",
      "type": "i64"
     },
     {
      "name": "runs",
      "type": "u32"
     },
     {
      "name": "max_runs",
      "type": "u32"
     }
    ]
   }
  },
  {
   "name": "ScheduleArgs",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "active",
      "type": "bool"
     },
     {
      "name": "action",
      "type": {
       "defined": {
        "name": "Action"
       }
      }
     },
     {
      "name": "every",
      "type": "i64"
     },
     {
      "name": "next_at",
      "type": "i64"
     },
     {
      "name": "max_runs",
      "type": "u32"
     }
    ]
   }
  },
  {
   "name": "ScheduleRan",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "run",
      "type": "u32"
     },
     {
      "name": "action",
      "type": {
       "defined": {
        "name": "Action"
       }
      }
     },
     {
      "name": "amount",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "Share",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "to",
      "type": {
       "defined": {
        "name": "To"
       }
      }
     },
     {
      "name": "bps",
      "type": "u16"
     }
    ]
   }
  },
  {
   "name": "Stake",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "bump",
      "type": "u8"
     },
     {
      "name": "mint",
      "type": "pubkey"
     },
     {
      "name": "rewards_pool",
      "type": "u8"
     },
     {
      "name": "rewards_mint",
      "type": "pubkey"
     },
     {
      "name": "lock",
      "type": "i64"
     },
     {
      "name": "total",
      "type": "u64"
     },
     {
      "name": "reward_per_token",
      "type": "u128"
     }
    ]
   }
  },
  {
   "name": "Staked",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "amount",
      "type": "u64"
     },
     {
      "name": "rewards",
      "type": "u64"
     },
     {
      "name": "staked",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "TicketsBought",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "round",
      "type": "u32"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "first_ticket",
      "type": "u64"
     },
     {
      "name": "count",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "To",
   "type": {
    "kind": "enum",
    "variants": [
     {
      "name": "Burn"
     },
     {
      "name": "Pool",
      "fields": [
       "u8"
      ]
     },
     {
      "name": "Account",
      "fields": [
       "pubkey"
      ]
     },
     {
      "name": "Holder",
      "fields": [
       "pubkey"
      ]
     }
    ]
   }
  },
  {
   "name": "TokenAttached",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "mint",
      "type": "pubkey"
     },
     {
      "name": "venue",
      "type": {
       "defined": {
        "name": "Venue"
       }
      }
     },
     {
      "name": "launcher",
      "type": "pubkey"
     }
    ]
   }
  },
  {
   "name": "TokenCleared",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "mint",
      "type": "pubkey"
     },
     {
      "name": "venue",
      "type": {
       "defined": {
        "name": "Venue"
       }
      }
     },
     {
      "name": "reason",
      "type": "u32"
     }
    ]
   }
  },
  {
   "name": "Unmade",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "authority",
      "type": "pubkey"
     },
     {
      "name": "asset",
      "type": "pubkey"
     },
     {
      "name": "reference",
      "type": {
       "array": [
        "u8",
        32
       ]
      }
     }
    ]
   }
  },
  {
   "name": "Unstaked",
   "type": {
    "kind": "struct",
    "fields": [
     {
      "name": "game",
      "type": "pubkey"
     },
     {
      "name": "id",
      "type": "u32"
     },
     {
      "name": "player",
      "type": "pubkey"
     },
     {
      "name": "amount",
      "type": "u64"
     },
     {
      "name": "rewards",
      "type": "u64"
     },
     {
      "name": "staked",
      "type": "u64"
     }
    ]
   }
  },
  {
   "name": "Venue",
   "type": {
    "kind": "enum",
    "variants": [
     {
      "name": "Meteora"
     },
     {
      "name": "PumpFun"
     }
    ]
   }
  },
  {
   "name": "Verdict",
   "type": {
    "kind": "enum",
    "variants": [
     {
      "name": "Open"
     },
     {
      "name": "Won"
     },
     {
      "name": "Off"
     }
    ]
   }
  }
 ],
 "constants": [
  {
   "name": "ASSET_SEED",
   "type": "bytes",
   "value": "[97, 115, 115, 101, 116]"
  },
  {
   "name": "BOX_SEED",
   "type": "bytes",
   "value": "[98, 111, 120]"
  },
  {
   "name": "CONTEST_SEED",
   "type": "bytes",
   "value": "[99, 111, 110, 116, 101, 115, 116]"
  },
  {
   "name": "ENTRY_SEED",
   "type": "bytes",
   "value": "[101, 110, 116, 114, 121]"
  },
  {
   "name": "ESCROW_LAMPORTS",
   "type": "u64",
   "value": "6000000"
  },
  {
   "name": "ESCROW_SEED",
   "type": "bytes",
   "value": "[101, 115, 99, 114, 111, 119]"
  },
  {
   "name": "FEES_SEED",
   "type": "bytes",
   "value": "[102, 101, 101, 115]"
  },
  {
   "name": "GAME_SEED",
   "type": "bytes",
   "value": "[103, 97, 109, 101]"
  },
  {
   "name": "HOLD_SEED",
   "type": "bytes",
   "value": "[104, 111, 108, 100]"
  },
  {
   "name": "ITEM_SEED",
   "type": "bytes",
   "value": "[105, 116, 101, 109]"
  },
  {
   "name": "LOTTERY_SEED",
   "type": "bytes",
   "value": "[108, 111, 116, 116, 101, 114, 121]"
  },
  {
   "name": "MAX_FEE_LAMPORTS",
   "type": "u64",
   "value": "10000000"
  },
  {
   "name": "NOTICE_SECONDS",
   "type": "i64",
   "value": "604800"
  },
  {
   "name": "ORDER_SEED",
   "type": "bytes",
   "value": "[111, 114, 100, 101, 114]"
  },
  {
   "name": "PLATFORM_SEED",
   "type": "bytes",
   "value": "[112, 108, 97, 116, 102, 111, 114, 109]"
  },
  {
   "name": "PLAYER_FEE_LAMPORTS",
   "type": "u64",
   "value": "2000000"
  },
  {
   "name": "POOL_SEED",
   "type": "bytes",
   "value": "[112, 111, 111, 108]"
  },
  {
   "name": "POSITION_SEED",
   "type": "bytes",
   "value": "[112, 111, 115, 105, 116, 105, 111, 110]"
  },
  {
   "name": "POT_SEED",
   "type": "bytes",
   "value": "[112, 111, 116]"
  },
  {
   "name": "PROJECT_FEE_LAMPORTS",
   "type": "u64",
   "value": "10000"
  },
  {
   "name": "RECIPE_SEED",
   "type": "bytes",
   "value": "[114, 101, 99, 105, 112, 101]"
  },
  {
   "name": "REWARDS_SEED",
   "type": "bytes",
   "value": "[114, 101, 119, 97, 114, 100, 115]"
  },
  {
   "name": "ROLLED_REFUND_SLOTS",
   "type": "u64",
   "value": "1512000"
  },
  {
   "name": "SCHEDULE_SEED",
   "type": "bytes",
   "value": "[115, 99, 104, 101, 100, 117, 108, 101]"
  },
  {
   "name": "STAKED_SEED",
   "type": "bytes",
   "value": "[115, 116, 97, 107, 101, 100]"
  },
  {
   "name": "STAKE_SEED",
   "type": "bytes",
   "value": "[115, 116, 97, 107, 101]"
  },
  {
   "name": "STALE_SLOTS",
   "type": "u64",
   "value": "1500"
  }
 ]
};
