import { NextResponse } from "next/server";
import { addUser, listUsers } from "../../../lib/users";

export async function GET() {
  return NextResponse.json({ users: listUsers() });
}

export async function POST(request: Request) {
  const body = await request.json();
  return NextResponse.json(addUser(body.name), { status: 201 });
}
