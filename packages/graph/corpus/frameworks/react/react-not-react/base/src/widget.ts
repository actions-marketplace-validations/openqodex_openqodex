import { useMemoize } from "memo-lib";
import { Component } from "./base";

// Extends a class named Component, but not React's, and renders a string.
export class Widget extends Component {
  render(): string {
    return "widget";
  }
}

// Named like a hook, but the use-named function it calls is not React's.
export function useCache(): number {
  return useMemoize(() => 1);
}

// Named like a hook, and calls a use-named function of its own module that is not one.
function useLocal(): number {
  return 2;
}

export function useTwice(): number {
  return useLocal() * 2;
}
