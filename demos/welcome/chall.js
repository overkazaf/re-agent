#!/usr/bin/env node

const key = 0x2a;
const encoded = [26, 82, 75, 76, 81, 93, 75, 88, 71, 95, 90, 117, 78, 79, 73, 65, 87];
const expected = encoded.map(value => String.fromCharCode(value ^ key)).join("");

const provided = process.argv[2] ?? "";

if (!provided) {
  console.log("usage: node chall.js <token>");
  process.exit(2);
}

if (provided === expected) {
  console.log("accepted");
  process.exit(0);
}

console.log("rejected");
process.exit(1);
