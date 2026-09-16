import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2 } from 'lucide-react';
import type { ServerConfig } from '@/bridge/types';

const hysteria2FormSchema = z.object({
  address: z.string().min(1, '服务器地址不能为空'),
  port: z.number().min(1, '端口必须大于 0').max(65535, '端口必须小于 65536'),
  password: z.string().min(1, '密码不能为空'),
  // 带宽限制
  upMbps: z.number().optional(),
  downMbps: z.number().optional(),
  // 混淆设置
  obfsType: z.enum(['none', 'salamander', 'gecko']),
  obfsPassword: z.string().optional(),
  obfsMinPacketSize: z.number().optional(),
  obfsMaxPacketSize: z.number().optional(),
  // 端口跳跃
  serverPorts: z.string().optional(),
  hopInterval: z.string().optional(),
  hopIntervalMax: z.string().optional(),
  // sing-box 1.14.0 新增
  bbrProfile: z.enum(['default', 'conservative', 'standard', 'aggressive']),
  chromeParrot: z.boolean(),
  // TLS 设置
  tlsServerName: z.string().optional(),
  tlsAllowInsecure: z.boolean(),
});

type Hysteria2FormValues = z.infer<typeof hysteria2FormSchema>;

interface Hysteria2FormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

/** 端口跳跃范围：逗号或空格分隔，如 "2080:3000, 4000:5000" */
function parseServerPorts(value?: string): string[] | undefined {
  const ports = (value || '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return ports.length > 0 ? ports : undefined;
}

export function Hysteria2Form({ serverConfig, onSubmit }: Hysteria2FormProps) {
  const form = useForm<Hysteria2FormValues>({
    resolver: zodResolver(hysteria2FormSchema),
    defaultValues: {
      address: '',
      port: 443,
      password: '',
      upMbps: undefined,
      downMbps: undefined,
      obfsType: 'none',
      obfsPassword: '',
      obfsMinPacketSize: undefined,
      obfsMaxPacketSize: undefined,
      serverPorts: '',
      hopInterval: '',
      hopIntervalMax: '',
      bbrProfile: 'default',
      chromeParrot: true,
      tlsServerName: '',
      tlsAllowInsecure: false,
    },
  });

  useEffect(() => {
    console.log('[Hysteria2Form] Server config changed:', serverConfig);
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'hysteria2') {
      const hy2 = serverConfig.hysteria2Settings;
      const formData = {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        password: serverConfig.password || '',
        upMbps: hy2?.upMbps ?? undefined,
        downMbps: hy2?.downMbps ?? undefined,
        obfsType: hy2?.obfs?.type ?? ('none' as const),
        obfsPassword: hy2?.obfs?.password || '',
        obfsMinPacketSize: hy2?.obfs?.minPacketSize ?? undefined,
        obfsMaxPacketSize: hy2?.obfs?.maxPacketSize ?? undefined,
        serverPorts: hy2?.serverPorts?.join(', ') || '',
        hopInterval: hy2?.hopInterval || '',
        hopIntervalMax: hy2?.hopIntervalMax || '',
        bbrProfile: hy2?.bbrProfile ?? ('default' as const),
        // 1.14 起默认开启伪装，只有显式关闭时才为 false
        chromeParrot: !hy2?.disableChromeParrot,
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
      };
      console.log('[Hysteria2Form] Resetting form with:', formData);
      form.reset(formData);
    }
  }, [serverConfig, form]);

  const handleSubmit = async (values: Hysteria2FormValues) => {
    const isGecko = values.obfsType === 'gecko';
    const serverPorts = parseServerPorts(values.serverPorts);

    const serverConfig: any = {
      protocol: 'hysteria2' as const,
      address: values.address,
      port: values.port,
      password: values.password,
      // Hysteria2 总是使用 TLS
      security: 'tls',
      tlsSettings: {
        serverName: values.tlsServerName || undefined,
        allowInsecure: values.tlsAllowInsecure,
      },
      hysteria2Settings: {
        upMbps: values.upMbps || undefined,
        downMbps: values.downMbps || undefined,
        obfs:
          values.obfsType !== 'none' && values.obfsPassword
            ? {
                type: values.obfsType,
                password: values.obfsPassword,
                ...(isGecko && values.obfsMinPacketSize
                  ? { minPacketSize: values.obfsMinPacketSize }
                  : {}),
                ...(isGecko && values.obfsMaxPacketSize
                  ? { maxPacketSize: values.obfsMaxPacketSize }
                  : {}),
              }
            : undefined,
        serverPorts,
        // 端口跳跃相关参数只在设置了范围时才有意义
        hopInterval: serverPorts ? values.hopInterval || undefined : undefined,
        hopIntervalMax: serverPorts ? values.hopIntervalMax || undefined : undefined,
        bbrProfile: values.bbrProfile === 'default' ? undefined : values.bbrProfile,
        // 只在关闭伪装时写入（1.14 默认即为开启）
        disableChromeParrot: values.chromeParrot ? undefined : true,
      },
    };

    await onSubmit(serverConfig);
  };

  const obfsType = form.watch('obfsType');
  const isObfsEnabled = obfsType !== 'none';
  const isGecko = obfsType === 'gecko';
  const hasServerPorts = !!parseServerPorts(form.watch('serverPorts'));

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>服务器地址</FormLabel>
              <FormControl>
                <Input placeholder="example.com" {...field} />
              </FormControl>
              <FormDescription>服务器的域名或 IP 地址</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="port"
          render={({ field }) => (
            <FormItem>
              <FormLabel>端口</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  placeholder="443"
                  {...field}
                  onChange={(e) => field.onChange(parseInt(e.target.value) || 0)}
                />
              </FormControl>
              <FormDescription>服务器端口号（1-65535）</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>密码 (Password)</FormLabel>
              <FormControl>
                <Input type="password" placeholder="输入 Hysteria2 密码" {...field} />
              </FormControl>
              <FormDescription>Hysteria2 服务器的认证密码</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="upMbps"
            render={({ field }) => (
              <FormItem>
                <FormLabel>上行带宽 (Mbps)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    placeholder="可选"
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      field.onChange(val ? parseInt(val) : undefined);
                    }}
                  />
                </FormControl>
                <FormDescription>留空使用 BBR</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="downMbps"
            render={({ field }) => (
              <FormItem>
                <FormLabel>下行带宽 (Mbps)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    placeholder="可选"
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      field.onChange(val ? parseInt(val) : undefined);
                    }}
                  />
                </FormControl>
                <FormDescription>留空使用 BBR</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="obfsType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>QUIC 流量混淆</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="不启用" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="none">不启用</SelectItem>
                  <SelectItem value="salamander">Salamander</SelectItem>
                  <SelectItem value="gecko">Gecko（2 代，1.14.0+）</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>必须与服务端一致，不一致会直接握手失败</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {isObfsEnabled && (
          <FormField
            control={form.control}
            name="obfsPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>混淆密码</FormLabel>
                <FormControl>
                  <Input type="password" placeholder="输入混淆密码" {...field} />
                </FormControl>
                <FormDescription>混淆器密码，需与服务端一致</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {isGecko && (
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="obfsMinPacketSize"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>最小包大小</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="默认 512"
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        field.onChange(val ? parseInt(val) : undefined);
                      }}
                    />
                  </FormControl>
                  <FormDescription>字节，仅 Gecko 有效</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="obfsMaxPacketSize"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>最大包大小</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="默认 1200"
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        field.onChange(val ? parseInt(val) : undefined);
                      }}
                    />
                  </FormControl>
                  <FormDescription>字节，仅 Gecko 有效</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        )}

        <FormField
          control={form.control}
          name="serverPorts"
          render={({ field }) => (
            <FormItem>
              <FormLabel>端口跳跃范围（可选）</FormLabel>
              <FormControl>
                <Input placeholder="2080:3000" {...field} />
              </FormControl>
              <FormDescription>
                填写后上方「端口」不再生效；多个范围用逗号分隔，如 2080:3000, 4000:5000
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {hasServerPorts && (
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="hopInterval"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>跳跃间隔</FormLabel>
                  <FormControl>
                    <Input placeholder="默认 30s" {...field} />
                  </FormControl>
                  <FormDescription>如 30s、1m</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="hopIntervalMax"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>间隔上限（可选）</FormLabel>
                  <FormControl>
                    <Input placeholder="用于随机化" {...field} />
                  </FormControl>
                  <FormDescription>实际间隔在其与跳跃间隔之间随机</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        )}

        <FormField
          control={form.control}
          name="bbrProfile"
          render={({ field }) => (
            <FormItem>
              <FormLabel>BBR 拥塞控制配置</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="默认（standard）" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="default">默认（standard）</SelectItem>
                  <SelectItem value="conservative">conservative（保守）</SelectItem>
                  <SelectItem value="standard">standard（标准）</SelectItem>
                  <SelectItem value="aggressive">aggressive（激进）</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>
                1.14.0+；仅在上行/下行带宽留空（即使用 BBR）时生效
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="chromeParrot"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>Chrome QUIC 指纹伪装</FormLabel>
                <FormDescription>
                  1.14.0+ 默认开启：QUIC 握手伪装成 Chrome，降低被指纹识别的概率。
                  服务端使用 Ed25519 证书时需关闭（Chrome 不支持该签名算法）
                </FormDescription>
              </div>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="tlsServerName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>TLS 服务器名称（可选）</FormLabel>
              <FormControl>
                <Input placeholder="example.com" {...field} />
              </FormControl>
              <FormDescription>用于 TLS SNI，留空则使用服务器地址</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="tlsAllowInsecure"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>允许不安全的连接</FormLabel>
                <FormDescription>跳过 TLS 证书验证（不推荐，仅用于测试）</FormDescription>
              </div>
            </FormItem>
          )}
        />

        <div className="flex gap-4">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            保存配置
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => form.reset()}
            disabled={form.formState.isSubmitting}
          >
            重置
          </Button>
        </div>
      </form>
    </Form>
  );
}
