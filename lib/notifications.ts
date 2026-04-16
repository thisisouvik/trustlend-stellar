import { getServiceRoleClient } from "@/lib/supabase/server";

export async function createNotification({
  userId,
  title,
  message,
  type,
}: {
  userId: string;
  title: string;
  message: string;
  type: string;
}) {
  const srClient = getServiceRoleClient();
  if (!srClient) return null;

  try {
    const { error } = await srClient.from("notifications").insert({
      user_id: userId,
      title,
      message,
      type,
    });
    if (error) {
      console.error("Failed to create notification:", error);
    }
  } catch (err) {
    console.error("Error creating notification", err);
  }
}
