/**
 * All money is stored as integer minor units (qəpik).
 * 1.20 AZN = 120
 */
function toMinor(azn) {
  return Math.round(Number(azn) * 100);
}

function toMajor(qepik) {
  return Number(qepik) / 100;
}

function add(a, b) {
  return Number(a) + Number(b);
}

function sub(a, b) {
  return Number(a) - Number(b);
}

function percentOf(amountMinor, percent) {
  return Math.round((Number(amountMinor) * Number(percent)) / 100);
}

module.exports = { toMinor, toMajor, add, sub, percentOf };
