/**
 * Sample TypeScript fixture for testing the parser.
 * Contains functions, classes, interfaces, types, and enums.
 */

import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

/** A greeting function */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

/** An async data fetcher */
export async function fetchData(url: string, timeout?: number): Promise<string> {
  const response = await fetch(url);
  return response.text();
}

export const add = (a: number, b: number): number => a + b;

export interface User {
  id: number;
  name: string;
  email: string;
  isActive: boolean;
}

export type UserId = number | string;

export enum Status {
  Active = 'active',
  Inactive = 'inactive',
  Pending = 'pending',
}

/** A repository class for managing users */
export class UserRepository {
  private users: Map<string, User> = new Map();

  /** Create a new user */
  async createUser(data: Omit<User, 'id'>): Promise<User> {
    const user: User = { ...data, id: Date.now() };
    this.users.set(String(user.id), user);
    return user;
  }

  /** Find a user by ID */
  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  /** Get all users */
  listUsers(): User[] {
    return [...this.users.values()];
  }

  static fromJSON(json: string): UserRepository {
    const repo = new UserRepository();
    return repo;
  }
}

const API_VERSION = '1.0.0';
