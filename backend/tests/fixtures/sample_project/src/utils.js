// Sample utilities for fragmentation fixtures.

function plainSum(a, b) {
  return a + b;
}

const arrow = (x) => x * 2;

export class Registry {
  constructor() {
    this.items = [];
  }

  register(item) {
    this.items.push(item);
  }
}
