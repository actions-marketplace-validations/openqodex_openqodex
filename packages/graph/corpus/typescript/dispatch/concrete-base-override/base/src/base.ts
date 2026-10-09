export class Base {
  save(): string {
    return "base";
  }

  run(): string {
    return this.save();
  }
}
