import os from 'node:os'
import { accessUrl } from './tunnel.js'

export function lanAddresses(port: number, token: string, interfaces = os.networkInterfaces()) {
  const addresses: string[] = []
  for (const entries of Object.values(interfaces)) for (const item of entries || []) {
    if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('172.17.')) {
      addresses.push(accessUrl(`http://${item.address}:${port}`, token))
    }
  }
  return [...new Set(addresses)]
}
