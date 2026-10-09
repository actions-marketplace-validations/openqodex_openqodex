export interface Repo<T> {
  find(id: string): T;
}

export interface User {
  name: string;
}

export interface Order {
  total: number;
}
