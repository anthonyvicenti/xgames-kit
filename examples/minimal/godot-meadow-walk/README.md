# Meadow Walk (example, runtime godot, seen from above)

The top-down starter on runtime godot: create's output from `spec.json` (camera `top`, world `field`), untouched. The
field is generated from the title (the same generator three's flat profile uses: walls round the edge, a path cross, a
pond, wall pieces), the body is a three-row gf-flat-1 sheet (facing down, side, up; the row follows where the player
heads), and the friends are drawn where they really are. One idea: the same GF autoload and parts as the side-on
starter, seen from above.

```bash
npx gamesfun create games/my-field --from godot-meadow-walk
npx gamesfun verify games/my-field
```
