// A second component named Button that nothing imports: a JSX <Button> elsewhere is not this one.
export function Button() {
  return <button type="button">other</button>;
}
