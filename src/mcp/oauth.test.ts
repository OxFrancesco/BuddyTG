import { expect, test } from "bun:test"
import { isPublicAddress } from "./oauth"

test("public IPv4 and IPv6 addresses are accepted", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "104.20.23.154", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    expect(isPublicAddress(address)).toBe(true)
  }
})

test("non-public and IPv4-embedding addresses are refused", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "127.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1",
    "192.0.0.8", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "0:0:0:0:0:0:0:1", "100::1",
    "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "feff::1", "ff02::1",
    "64:ff9b::a00:1", "64:ff9b:1::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "2002:a00:1::1",
    "not-an-ip",
  ]) {
    expect(isPublicAddress(address)).toBe(false)
  }
})
