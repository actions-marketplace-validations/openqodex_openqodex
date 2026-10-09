// A string store. A key that holds nothing reads as "".
export interface Cache {
  get(key: string): string;
  set(key: string, value: string): void;
}
