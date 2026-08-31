// Prints the argv it actually received, as one JSON line on stdout.
//
// This exists to prove a negative that no unit test can: that nothing between the launch
// configuration and the operating system re-interprets an argument. A shell would split
// `a b`, strip quotes, expand `$(...)`, and act on `;` — so a fixture that echoes argv back
// verbatim is the only way to show the arguments arrived as literals.
process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\n`);
