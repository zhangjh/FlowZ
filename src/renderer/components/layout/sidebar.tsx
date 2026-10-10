import { useState } from 'react';
import { Home, Server, ListFilter, Settings } from 'lucide-react';
import { platform } from '@tauri-apps/plugin-os';
import { cn } from '@/lib/utils';

interface SidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
}

const navItems = [
  { id: 'home', label: '首页', icon: Home },
  { id: 'server', label: '服务器', icon: Server },
  { id: 'rules', label: '规则', icon: ListFilter },
  { id: 'settings', label: '设置', icon: Settings },
];

export function Sidebar({ currentView, onViewChange }: SidebarProps) {
  const [isMac] = useState(() => {
    try {
      return platform() === 'macos';
    } catch {
      return false;
    }
  });
  return (
    <div className="w-[200px] border-r bg-card h-full flex flex-col">
      <div className={cn('p-4 border-b', isMac && 'pt-8')}>
        <h1 className="text-lg font-semibold">FlowZ</h1>
      </div>
      <nav className="flex-1 p-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                currentView === item.id
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-accent hover:text-accent-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
