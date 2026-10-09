"use server";

export async function saveProfile(formData: FormData): Promise<void> {
  const name = formData.get("name");
  console.log("saving", name);
}
