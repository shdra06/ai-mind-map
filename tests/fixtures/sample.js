/**
 * Sample JavaScript fixture for testing the parser.
 * Contains functions, classes, and exports.
 */

const EventEmitter = require('node:events');

/**
 * Greet a user by name.
 * @param {string} name
 * @returns {string}
 */
export function greet(name) {
  return `Hello, ${name}!`;
}

export async function fetchData(url, options = {}) {
  const res = await fetch(url, options);
  return res.json();
}

export const multiply = (a, b) => a * b;

export class TaskRunner {
  constructor(concurrency = 4) {
    this.concurrency = concurrency;
    this.tasks = [];
  }

  addTask(task) {
    this.tasks.push(task);
  }

  async runAll() {
    const results = [];
    for (const task of this.tasks) {
      results.push(await task());
    }
    return results;
  }

  static create(options) {
    return new TaskRunner(options.concurrency);
  }
}

const DEFAULT_TIMEOUT = 5000;
