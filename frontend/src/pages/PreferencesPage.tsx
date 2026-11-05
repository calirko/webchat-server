import { NotificationPrefsCard } from '../components/NotificationPrefsCard';

/**
 * Personal to the signed-in agent — notifications. Kept
 * separate from Profile (the shared WhatsApp account identity) so changing
 * your own notification prefs never reads as touching the whole line, and
 * from Settings (admin-only) since every agent needs to reach these.
 */
export default function PreferencesPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-5 overflow-y-auto p-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Preferences</h2>
        <p className="text-sm text-gray-500">
          Yours alone — how and when you get notified. Nothing here is shared
          with other agents or changes what anyone else sees.
        </p>
      </div>

      <NotificationPrefsCard />
    </div>
  );
}
