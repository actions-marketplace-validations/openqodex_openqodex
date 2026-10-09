import { Order, Repo } from "./types";

export class OrderRepo implements Repo<Order> {
  find(id: string): Order {
    return { total: id.length };
  }
}
