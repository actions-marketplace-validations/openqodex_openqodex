export abstract class BaseRepo {
  abstract find(id: string): string;

  describe(): string {
    return "repo";
  }
}
