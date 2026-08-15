export type DeckNotificationPermission = NotificationPermission | "unsupported";

export function systemNotificationPermission(): DeckNotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window))
    return "unsupported";
  return Notification.permission;
}

export async function requestSystemNotifications() {
  if (systemNotificationPermission() === "unsupported") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export function sendSystemNotification({
  title,
  body,
  tag,
  requireInteraction = false,
  onClick,
}: {
  title: string;
  body: string;
  tag: string;
  requireInteraction?: boolean;
  onClick: () => void;
}) {
  if (systemNotificationPermission() !== "granted") return false;
  try {
    const notification = new Notification(title, {
      body,
      tag,
      requireInteraction,
    });
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
