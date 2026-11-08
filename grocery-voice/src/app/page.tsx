import { redirect } from "next/navigation";
import { getUser } from "@/features/auth/session";

export default async function Home() {
  redirect((await getUser()) ? "/list" : "/login");
}
