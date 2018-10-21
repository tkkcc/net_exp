#include <iostream>
#include <vector>
#include "sysInclude.h"
using namespace std;
typedef unsigned int uint;
typedef unsigned short ushort;
extern void fwd_LocalRcv(char *pBuffer, int length);
extern void fwd_SendtoLower(char *pBuffer, int length, uint nexthop);
extern void fwd_DiscardPkt(char *pBuffer, int type);
extern uint getIpv4Address();
// set tail = 00000...
uint getLow(uint IP, uint masklen) {
  masklen = 32 - masklen;
  IP >>= masklen;
  IP <<= masklen;
  return IP;
}
// set tail = 11111...
uint getHigh(uint IP, uint masklen) {
  masklen = 32 - masklen;
  IP |= (1 << masklen) - 1;
  return IP;
}

struct route {
  uint low, high, masklen, nextIP;
  route(uint low, uint high, uint masklen, uint nextIP) {
    this->low = low;
    this->high = high;
    this->masklen = masklen;
    this->nextIP = nextIP;
  }
};

vector<route> vec;

void stud_Route_Init() {
  vec.clear();
  return;
} 

void stud_route_add(stud_route_msg *proute) {
  uint dest = htonl(proute->dest);
  uint masklen = htonl(proute->masklen);
  uint nextIP = htonl(proute->nexthop);
  uint low = getLow(dest, masklen);
  uint high = getHigh(dest, masklen);
  vec.push_back(route(low, high, masklen, nextIP));
  return;
}

bool get_next_ip(uint destIP, uint &nextIP) {
  uint len = 0;
  bool ret = false;
  for (uint i = 0; i < vec.size(); i++)
    if (vec[i].low <= destIP && vec[i].high >= destIP)
      if (vec[i].masklen >= len) {
        len = vec[i].masklen;
        nextIP = vec[i].nextIP;
        ret = true;
      }
  return ret;
}

int stud_fwd_deal(char *pBuffer, int length) {
  uint destIP = ntohl(*(uint *)(pBuffer + 16));
  if (destIP == 0xFFFFFFFF || destIP == getIpv4Address()) {
    fwd_LocalRcv(pBuffer, length);
    return 1;
  }

  uint ttl = (uint)(pBuffer[8]);
  if (ttl == 0) {
    fwd_DiscardPkt(pBuffer, STUD_FORWARD_TEST_TTLERROR);
    return 1;
  }

  uint nextIP;
  if (!get_next_ip(destIP, nextIP)) {
    fwd_DiscardPkt(pBuffer, STUD_FORWARD_TEST_NOROUTE);
    return 1;
  }

  // ttl-1
  pBuffer[8] = (ttl - 1) & 0xff;
  // re calculate checksum
  *(ushort *)(pBuffer + 10) = 0;
  int sum = 0;
  for (int i = 0; i < 10; ++i) sum += (int)(*(ushort *)(pBuffer + i * 2));
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >> 16);
  sum = ~((ushort)sum);
  *(ushort *)(pBuffer + 10) = (ushort)sum;

  fwd_SendtoLower(pBuffer, length, nextIP);
  return 0;
}
