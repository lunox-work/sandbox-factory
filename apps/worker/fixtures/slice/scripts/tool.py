import os
import boto3

from scripts.helper import helper


def main():
    return helper(os.environ["BUCKET"])
