#include <algorithm>
#include <iostream>
#include <vector>
struct Node { double heuristic; int id; };
int main() {
  int size;
  while (std::cin >> size) {
    std::vector<Node> nodes(size);
    for (int i = 0; i < size; ++i) { std::cin >> nodes[i].heuristic; nodes[i].id = i; }
    // Original result_fst::cmp casts both heuristic operands to int.
    std::sort(nodes.begin(), nodes.end(), [](const Node &a, const Node &b) {
      int score1 = a.heuristic;
      int score2 = b.heuristic;
      return score1 < score2;
    });
    for (auto node : nodes) std::cout << node.id << ' ';
    std::cout << '\n';
  }
}
