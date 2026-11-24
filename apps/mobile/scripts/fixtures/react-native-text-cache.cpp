#include <chrono>
#include <future>
#include <iostream>
#include <optional>
#include <string>
#include <thread>
#include <react/utils/SimpleThreadSafeCache.h>

using facebook::react::SimpleThreadSafeCache;
using namespace std::chrono_literals;

// Models the first sheet layout: text measurement on the JS thread waits for
// main, which needs to measure another TextInput through the same cache.
int main() {
  SimpleThreadSafeCache<int, std::string, 3> cache;
  std::promise<void> mainMeasured;
  auto mainFinished = mainMeasured.get_future();
  std::thread mainThread;
  auto first = cache.get(1, [&] {
    mainThread = std::thread([&] {
      cache.get(2, [] { return std::string("main"); });
      mainMeasured.set_value();
    });
    return std::string(mainFinished.wait_for(1s) == std::future_status::ready ? "js" : "blocked");
  });
  mainThread.join();
  if (first != "js" || cache.get(2) != "main") {
    std::cerr << "Text measurement held the cache lock while waiting for main\n";
    return 1;
  }

  // A competing measurement of the same key may win during generation.
  std::promise<void> inserted;
  auto insertionFinished = inserted.get_future();
  std::thread competitor;
  auto winner = cache.get(3, [&] {
    competitor = std::thread([&] {
      cache.get(3, [] { return std::string("winner"); });
      inserted.set_value();
    });
    insertionFinished.wait_for(1s);
    return std::string("duplicate");
  });
  competitor.join();
  if (winner != "winner" || cache.get(3) != "winner") {
    std::cerr << "Concurrent measurement replaced the first cached value\n";
    return 2;
  }

  // Hits must not generate again, and insertions must still evict the LRU.
  auto [key, value] = cache.getWithKey(1, [] { return std::string("wrong"); });
  if (*key != 1 || *value != "js") return 3;
  cache.get(4, [] { return std::string("four"); });
  if (cache.get(2) == "main" || cache.get(1) != "js") return 4;
  std::cout << "PASS: first sheet measurement, concurrent insertion, cache hits and eviction\n";
}
