/**
 * 自动选择设置组件
 * 配置自动选择最佳服务器和故障转移功能
 */

import { useAppStore } from '@/store/app-store';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

export function AutoSelectSettings() {
  const config = useAppStore((state) => state.config);
  const updateAutoSelectConfig = useAppStore((state) => state.updateAutoSelectConfig);
  const testAllServers = useAppStore((state) => state.testAllServers);
  const isSpeedTesting = useAppStore((state) => state.isSpeedTesting);

  const autoSelect = config?.autoSelect ?? {
    enabled: false,
    mode: 'latency' as const,
    interval: 60,
    failoverEnabled: true,
  };

  const handleToggle = async (enabled: boolean) => {
    await updateAutoSelectConfig({ ...autoSelect, enabled });
    toast.success(enabled ? '自动选择已启用' : '自动选择已禁用');
  };

  const handleFailoverToggle = async (failoverEnabled: boolean) => {
    await updateAutoSelectConfig({ ...autoSelect, failoverEnabled });
    toast.success(failoverEnabled ? '故障转移已启用' : '故障转移已禁用');
  };

  const handleModeChange = async (mode: 'latency' | 'speed') => {
    await updateAutoSelectConfig({ ...autoSelect, mode });
  };

  const handleIntervalChange = async (interval: string) => {
    const value = parseInt(interval, 10);
    if (!isNaN(value) && value >= 10) {
      await updateAutoSelectConfig({ ...autoSelect, interval: value });
    }
  };

  const handleTestNow = async () => {
    try {
      await testAllServers();
      toast.success('服务器测试完成');
    } catch (error) {
      toast.error('测试失败', {
        description: error instanceof Error ? error.message : '测试服务器时发生错误',
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>自动选择最佳服务器</CardTitle>
        <CardDescription>
          自动测试服务器延迟并选择最快的服务器，支持故障转移
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="auto-select">启用自动选择</Label>
            <p className="text-sm text-muted-foreground">
              启动时自动选择延迟最低的服务器
            </p>
          </div>
          <Switch
            id="auto-select"
            checked={autoSelect.enabled}
            onCheckedChange={handleToggle}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="failover">启用故障转移</Label>
            <p className="text-sm text-muted-foreground">
              当服务器不可用时自动切换到可用服务器
            </p>
          </div>
          <Switch
            id="failover"
            checked={autoSelect.failoverEnabled}
            onCheckedChange={handleFailoverToggle}
          />
        </div>

        <div className="space-y-2">
          <Label>测试模式</Label>
          <Select
            value={autoSelect.mode}
            onValueChange={(value) => handleModeChange(value as 'latency' | 'speed')}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latency">延迟优先（推荐）</SelectItem>
              <SelectItem value="speed">速度优先</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            延迟优先选择响应最快的服务器，速度优先选择下载速度最高的服务器
          </p>
        </div>

        <div className="space-y-2">
          <Label>检测间隔（秒）</Label>
          <Select
            value={String(autoSelect.interval)}
            onValueChange={handleIntervalChange}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="30">30 秒</SelectItem>
              <SelectItem value="60">60 秒</SelectItem>
              <SelectItem value="120">120 秒</SelectItem>
              <SelectItem value="300">300 秒</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            定期检查当前服务器是否可用
          </p>
        </div>

        <div className="pt-2">
          <Button
            onClick={handleTestNow}
            variant="outline"
            disabled={isSpeedTesting}
            className="w-full"
          >
            {isSpeedTesting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                测试中...
              </>
            ) : (
              '立即测试所有服务器'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
