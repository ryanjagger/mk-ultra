// One-time generator for the quarter-wave sine table committed in
// packages/sim/src/trig.ts. The table is committed as literals precisely so
// that Math.sin is never executed by the sim at runtime (cross-engine
// determinism). Re-run only if you change the table resolution, and paste the
// output into trig.ts.
const N = 256;
const vals = [];
for (let i = 0; i <= N; i++) vals.push(Math.round(Math.sin(((i / N) * Math.PI) / 2) * 65536));
vals.push(vals[N]); // duplicated endpoint so lerp never reads out of range
let out = '';
for (let i = 0; i < vals.length; i += 16) out += '  ' + vals.slice(i, i + 16).join(', ') + ',\n';
console.log(out);
