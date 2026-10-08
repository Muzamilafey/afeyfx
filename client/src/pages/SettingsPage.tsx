import { Card } from '../components/ui';
import { SecuritySettings } from '../components/SecuritySettings';
import { useAuth } from '../hooks/useAuth';

export function SettingsPage() {
  const { user } = useAuth();
  return (
    <div className="max-w-3xl space-y-4">
      <Card title="Account">
        <div className="text-sm">
          {user?.name} · {user?.email} · <span className="uppercase">{user?.role}</span>
        </div>
      </Card>
      <SecuritySettings />
    </div>
  );
}
