"""Sample calculator for fragmentation fixtures."""

import math


CONSTANT = 42


class Calculator:
    """A tiny calculator."""

    def __init__(self, precision: int = 2) -> None:
        self.precision = precision

    def add(self, a: float, b: float) -> float:
        return round(a + b, self.precision)

    @staticmethod
    def helper(value: float) -> float:
        return math.sqrt(value)


def helper(x: float) -> float:
    """Module-level function with the same name as the method above."""
    return x * 2
